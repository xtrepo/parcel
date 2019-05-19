// @flow

import type {
  BuildFailureEvent,
  BuildSuccessEvent,
  InitialParcelOptions,
  ParcelOptions,
  Stats,
  Subscription
} from '@parcel/types';
import type {Bundle} from './types';
import type InternalBundleGraph from './BundleGraph';

import {Asset} from './public/Asset';
import {BundleGraph} from './public/BundleGraph';
import BundlerRunner from './BundlerRunner';
import WorkerFarm from '@parcel/workers';
import nullthrows from 'nullthrows';
import clone from 'clone';
import Cache from '@parcel/cache';
import watcher from '@parcel/watcher';
import path from 'path';
import AssetGraphBuilder, {BuildAbortError} from './AssetGraphBuilder';
import ConfigResolver from './ConfigResolver';
import ReporterRunner from './ReporterRunner';
import MainAssetGraph from './public/MainAssetGraph';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import resolveOptions from './resolveOptions';
import {ValueEmitter} from '@parcel/events';

type BuildEvent = BuildFailureEvent | BuildSuccessEvent;

export default class Parcel {
  #assetGraphBuilder; // AssetGraphBuilder
  #bundlerRunner; // BundlerRunner
  #farm; // WorkerFarm
  #initialized = false; // boolean
  #initialOptions; // InitialParcelOptions;
  #reporterRunner; // ReporterRunner
  #resolvedOptions = null; // ?ParcelOptions
  #runPackage; // (bundle: Bundle, bundleGraph: InternalBundleGraph) => Promise<Stats>;
  #buildEvents; // : ValueEmitter<BuildEvent>;
  #watchErrors; // : ValueEmitter<mixed>;
  #watcherSubscription; // AyncSubscription
  #watcherCount = 0; // number

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = clone(options);
    this.#buildEvents = new ValueEmitter<BuildEvent>();
    this.#watchErrors = new ValueEmitter<mixed>();
  }

  async init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions
    );
    this.#resolvedOptions = resolvedOptions;
    await Cache.createCacheDir(resolvedOptions.cacheDir);

    let configResolver = new ConfigResolver();
    let config;

    // If an explicit `config` option is passed use that, otherwise resolve a .parcelrc from the filesystem.
    if (resolvedOptions.config) {
      config = await configResolver.create(resolvedOptions.config);
    } else {
      config = await configResolver.resolve(resolvedOptions.rootDir);
    }

    // If no config was found, default to the `defaultConfig` option if one is provided.
    if (!config && resolvedOptions.defaultConfig) {
      config = await configResolver.create(resolvedOptions.defaultConfig);
    }

    if (!config) {
      throw new Error('Could not find a .parcelrc');
    }

    this.#bundlerRunner = new BundlerRunner({
      options: resolvedOptions,
      config
    });

    this.#reporterRunner = new ReporterRunner({
      config,
      options: resolvedOptions
    });

    this.#assetGraphBuilder = new AssetGraphBuilder({
      options: resolvedOptions,
      config,
      entries: resolvedOptions.entries,
      targets: resolvedOptions.targets
    });

    this.#farm = await WorkerFarm.getShared(
      {
        config,
        options: resolvedOptions,
        env: resolvedOptions.env
      },
      {
        workerPath: require.resolve('./worker')
      }
    );

    this.#runPackage = this.#farm.mkhandle('runPackage');
    this.#initialized = true;
  }

  // `run()` returns `Promise<?BundleGraph>` because in watch mode it does not
  // return a bundle graph, but outside of watch mode it always will.
  async run(): Promise<?BundleGraph> {
    if (!this.#initialized) {
      await this.init();
    }

    let bundleGraph = await this.build();

    let resolvedOptions = nullthrows(this.#resolvedOptions);
    if (resolvedOptions.killWorkers !== false) {
      await this.#farm.end();
    }

    return bundleGraph;
  }

  watch(cb?: (err: ?mixed, buildEvent?: BuildEvent) => mixed): Subscription {
    let buildEventsDisposable;
    let watchErrorsDisposable;
    if (cb) {
      buildEventsDisposable = this.#buildEvents.addListener(buildEvent =>
        nullthrows(cb)(null, buildEvent)
      );
      watchErrorsDisposable = this.#watchErrors.addListener(err =>
        nullthrows(cb)(err)
      );
    }

    if (this.#watcherCount === 0) {
      (async () => {
        if (!this.#initialized) {
          await this.init();
        }

        let resolvedOptions = nullthrows(this.#resolvedOptions);
        let targetDirs = resolvedOptions.targets.map(target =>
          path.resolve(target.distDir)
        );
        let cacheDir = path.resolve(resolvedOptions.cacheDir);
        let vcsDirs = ['.git', '.hg'].map(dir =>
          path.join(resolvedOptions.projectRoot, dir)
        );
        let ignore = [cacheDir, ...targetDirs, ...vcsDirs];
        this.#watcherSubscription = await watcher.subscribe(
          resolvedOptions.projectRoot,
          (err, events) => {
            if (err) {
              this.#watchErrors.emit(err);
              return;
            }

            this.#assetGraphBuilder.respondToFSEvents(events);
            if (this.#assetGraphBuilder.isInvalid()) {
              this.build().catch(err => {
                if (!(err instanceof BuildError)) {
                  this.#watchErrors.emit(err);
                }
                // If this is a BuildError, do nothing. In watch mode, reporters
                // should alert the user something is broken, which allows Parcel
                // to gracefully continue once the user makes the correct changes
              });
            }
          },
          {ignore}
        );

        this.#reporterRunner.report({type: 'watchStart'});

        return this.build();
      })().catch(err => {
        this.#watchErrors.emit(err);
      });
    }

    this.#watcherCount++;

    return {
      unsubscribe: async () => {
        if (buildEventsDisposable) {
          buildEventsDisposable.dispose();
        }
        if (watchErrorsDisposable) {
          watchErrorsDisposable.dispose();
        }

        this.#watcherCount--;
        if (this.#watcherCount === 0) {
          await this.#reporterRunner.report({type: 'watchEnd'});
          await this.#watcherSubscription.unsubscribe();
        }
      }
    };
  }

  async build(): Promise<BundleGraph> {
    try {
      this.#reporterRunner.report({
        type: 'buildStart'
      });

      let startTime = Date.now();
      let {assetGraph, changedAssets} = await this.#assetGraphBuilder.build();
      dumpGraphToGraphViz(assetGraph, 'MainAssetGraph');

      let bundleGraph = await this.#bundlerRunner.bundle(assetGraph);
      dumpGraphToGraphViz(bundleGraph, 'BundleGraph');

      await packageBundles(bundleGraph, this.#runPackage);

      let event = {
        type: 'buildSuccess',
        changedAssets: new Map(
          Array.from(changedAssets).map(([id, asset]) => [id, new Asset(asset)])
        ),
        assetGraph: new MainAssetGraph(assetGraph),
        bundleGraph: new BundleGraph(bundleGraph),
        buildTime: Date.now() - startTime
      };
      this.#reporterRunner.report(event);
      this.#buildEvents.emit(event);

      return new BundleGraph(bundleGraph);
    } catch (e) {
      if (!(e instanceof BuildAbortError)) {
        let event = {
          type: 'buildFailure',
          error: e
        };
        await this.#reporterRunner.report(event);
        this.#buildEvents.emit(event);
      }

      throw new BuildError(e);
    }
  }
}

function packageBundles(
  bundleGraph: InternalBundleGraph,
  runPackage: (
    bundle: Bundle,
    bundleGraph: InternalBundleGraph
  ) => Promise<Stats>
): Promise<mixed> {
  let promises = [];
  bundleGraph.traverseBundles(bundle => {
    promises.push(
      runPackage(bundle, bundleGraph).then(stats => {
        bundle.stats = stats;
      })
    );
  });

  return Promise.all(promises);
}

export class BuildError extends Error {
  name = 'BuildError';
  error: mixed;

  constructor(error: mixed) {
    super(error instanceof Error ? error.message : 'Unknown Build Error');
    this.error = error;
  }
}

export {default as Asset} from './Asset';
export {default as Dependency} from './Dependency';
export {default as Environment} from './Environment';
