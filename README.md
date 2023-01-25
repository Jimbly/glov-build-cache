Git-commit-able caching wrapper for slow [glov-build](https://github.com/Jimbly/glov-build) tasks
=============================

Though [glov-build](https://github.com/Jimbly/glov-build) is already highly cached and only reprocesses exactly the files needed to be reprocessed on your machine, some tasks (such as `imagemin`) are so slow that you do not want to have to run them even once on a new developer's machine, or on a build system (which may be unable to take advantage of a local cache between runs).

This task wrapper is for caching single-input/output tasks such as image minification or other image postprocessing.

API usage:
```javascript
const gbcache = require('glov-build-cache');

gb.task({
  name: 'name',
  input: '*.png',
  ...gbcache({
    key: 'cache-key',
    version: 1,
    cache_root: './.gbcache',
    do_cache_write: false,
    do_cache_rebuild: false,
  }, {
    // actual task definition here
    type: gb.SINGLE,
    func: doSomething,
  },
});
```
Options
* **`key`** - required cache key
* **`version`** - required cache version - This must be _manually_ incremented when your task's version changes.  The automatic hashing of task functions to detect version changes is unstable across Node.js version and platforms, so cannot be used lest the cache be invalid on any installation other than the one that generated it.
* **`cache_root`** - optional root folder for caching, defaults to `gb.getSourceRoot()/../.gbcache/`
* **`do_cache_write`** optional boolean to enable writing to the cache after every task run, defaults to `false` unless `--cache-write` is passed on the command line.  This is generally not recommended unless you want developers to always commit and updated cache folder with each commit that changes one of the sources (which has increases the chance of meaningless merge conflicts, etc).
* **`do_cache_rebuild`** optional boolean to enable pruning and rebuilding the cache during the first task run, defaults to `false` unless `--cache-rebuild` is passed on the command line.  This should be done only periodically when the cache is significantly out of date and needs to be updated and committed to source control.


Example usage in build script:
```javascript
const imagemin = require('glov-build-imagemin');
const imageminOptipng = require('imagemin-optipng');

const gbcache = require('glov-build-cache');

gb.task({
  name: 'imagemin',
  input: '*.png',
  ...gbcache({
    key: 'imagemin',
    version: 1,
  }, imagemin({
    plugins: [
      imageminOptipng(),
    ],
  })),
});
```
Example occasional workflow to update cache for the rest of your team or build systems, etc:
```
node build imagemin --cache-rebuild
git add .
git commit -m "update build cache"
```
