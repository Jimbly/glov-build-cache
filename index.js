const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { gzipSync, gunzip } = require('zlib');
const { asyncEach } = require('glov-async');
const gb = require('glov-build');
const argv = require('minimist')(process.argv.slice(2));

function hash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function safeFilename(relative) {
  relative = relative.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (relative.endsWith('.gz')) {
    // will confuse internal logic
    relative = relative.replace(/\.gz$/, '.sourcegz');
  }
  return relative;
}

module.exports = function gbcache(cache_opts, task_opts) {
  let {
    key,
    version,
    cache_root,
    do_cache_write,
    do_cache_rebuild,
    gzexts,
  } = cache_opts;
  assert.equal(typeof key, 'string');
  assert.equal(typeof version, 'number');
  assert.equal(task_opts.type, gb.SINGLE);
  assert(!task_opts.finish);

  if (do_cache_rebuild === undefined) {
    do_cache_rebuild = argv['cache-rebuild'];
  }
  if (do_cache_rebuild) {
    do_cache_write = true;
  }
  if (do_cache_write === undefined) {
    do_cache_write = argv['cache-write'];
  }
  if (gzexts === undefined) {
    gzexts = [];
  }
  let gzmap = {};
  for (let ii = 0; ii < gzexts.length; ++ii) {
    gzmap[gzexts[ii]] = true;
  }

  cache_root = cache_root || path.resolve(gb.getSourceRoot(), '../.gbcache');
  let cache_folder = path.join(cache_root, key);
  let cache_index_path = path.join(cache_root, `${key}.index.txt`);
  let index;
  let new_index;

  function recordToFilename2(file_entry) {
    assert(file_entry.output_hash);
    let fn = safeFilename(file_entry.relative);
    let ext_idx = fn.lastIndexOf('.');
    let ext = '';
    if (ext_idx !== -1) {
      ext = fn.slice(ext_idx);
      fn = fn.slice(0, ext_idx);
    }
    let gz = '';
    if (gzmap[ext]) {
      gz = '.gz';
    }
    return `${cache_folder}/${fn}#${file_entry.output_hash.slice(-7)}${ext}${gz}`;
  }

  function inputHash(record) {
    let { inputs } = record;
    assert(inputs[0].relative === '&the');
    let ret = [];
    ret.push(inputs[0].input_hash);
    for (let ii = 1; ii < inputs.length; ++ii) {
      let elem = inputs[ii];
      ret.push(elem.bucket, elem.relative, elem.input_hash);
    }
    return ret.join(':');
  }

  let cache_hit;
  let cache_miss;
  function init(next) {
    new_index = {};
    cache_hit = 0;
    cache_miss = 0;
    fs.readFile(cache_index_path, 'utf8', function (err, data) {
      index = {};
      if (!err && data) {
        data.split('\n').forEach((line) => {
          if (!line || line.startsWith('//')) {
            return;
          }
          line = line.split(';');
          let [relative, ver, deps_string, ...outputs] = line;
          let entry = index[relative] = {
            relative,
            ver: Number(ver),
            inputs: [],
            outputs: [],
          };
          let parts = deps_string.split(':');
          assert(parts.length % 3 === 1); // should be 1 + 3xN
          entry.inputs.push({
            relative: '&the',
            input_hash: parts[0],
          });
          for (let ii = 1; ii < parts.length; ii+=3) {
            entry.inputs.push({
              bucket: parts[ii],
              relative: parts[ii+1],
              input_hash: parts[ii+2],
            });
          }
          if (outputs.length % 2) {
            // odd number, first entry must be identity name
            entry.outputs.push({
              relative,
              output_hash: outputs[0],
            });
            outputs.splice(0, 1);
          }
          for (let ii = 0; ii < outputs.length; ii += 2) {
            entry.outputs.push({
              relative: outputs[ii],
              output_hash: outputs[ii+1],
            });
          }
        });
      }
      if (task_opts.init) {
        task_opts.init(next);
      } else {
        next();
      }
    });
  }
  function func(job, done) {
    let file = job.getFile();

    assert(!file.relative.includes(';')); // not supported, used internally as a delimiter
    assert(!file.relative.includes(':')); // not supported, used internally as a delimiter

    function cacheMiss() {
      // run job, save output to cache if needed
      ++cache_miss;
      task_opts.func(job, function (err) {
        if (err) {
          return void done(err);
        }
        let deps = job.getDeps();
        assert(deps.includes(`${file.bucket}:${file.relative}`)); // must have at least the main file!

        let new_entry;
        if (do_cache_write) {
          new_entry = new_index[file.relative] = {
            relative: file.relative,
            ver: version,
            inputs: [],
            outputs: [],
          };
        }
        function gatherDeps(next) {
          if (!do_cache_write) {
            return void next();
          }
          asyncEach(deps, function (dep_name, next) {
            if (dep_name === `${file.bucket}:${file.relative}`) {
              new_entry.inputs.push({
                relative: '&the',
                input_hash: hash(file.contents),
              });
              return void next();
            }
            job.depAdd(dep_name, function (err, depfile) {
              let input_hash;
              if (err) {
                input_hash = 'null';
              } else {
                assert(depfile.contents instanceof Buffer);
                input_hash = hash(depfile.contents);
              }
              let [bucket, relative] = dep_name.split(':');
              new_entry.inputs.push({
                bucket,
                relative,
                input_hash,
              });
              next();
            });
          }, next);
        }
        function hashOutputs() {
          let output_queue = job.getOutputQueue();
          let output_keys = Object.keys(output_queue);
          for (let ii = 0; ii < output_keys.length; ++ii) {
            let outputkey = output_keys[ii];
            let output_file = output_queue[outputkey];
            let { contents, relative } = output_file;
            assert(Buffer.isBuffer(contents));
            if (do_cache_write) {
              let output_hash = hash(contents);
              new_entry.outputs.push({
                relative,
                output_hash,
                needs_write: true,
                contents,
              });
            }
          }
        }
        gatherDeps(function () {
          hashOutputs();
          done();
        });
      });
    }

    let cache_record = index[file.relative];
    if (!cache_record) {
      return void cacheMiss();
    }
    // check all deps
    function checkDeps(next) {
      let deps_match = true;
      asyncEach(cache_record.inputs, function (elem, next) {
        if (elem.relative === '&the') {
          let new_hash = hash(file.contents);
          if (new_hash !== elem.input_hash) {
            deps_match = false;
          }
          return void next();
        }
        job.depAdd(`${elem.bucket}:${elem.relative}`, function (err, depfile) {
          let new_hash;
          if (err) {
            new_hash = 'null';
          } else {
            assert(depfile.contents instanceof Buffer);
            new_hash = hash(depfile.contents);
          }
          if (new_hash !== elem.input_hash) {
            deps_match = false;
          }
          next();
        });
      }, function () {
        next(deps_match);
      });
    }
    // check all outputs - note: need to do this even if we have a cache miss, so we know which files to re-write
    function checkOutputs(force_miss) {
      let outputs = [];
      asyncEach(cache_record.outputs, function (file_entry, next, idx) {
        let cached_file = recordToFilename2(file_entry);
        function uncompress(buffer, next) {
          if (!cached_file.endsWith('.gz')) {
            return void next(null, buffer);
          }
          gunzip(buffer, next);
        }
        fs.readFile(cached_file, function (err, buffer) {
          if (err) {
            job.warn(`gbcache: unable to load file referenced by cache: ${cached_file} (${err})`);
            force_miss = true;
            file_entry.output_hash = 'invalid'; // if a later output matches the old hash, we *do* need to write it!
            return void next();
          }
          uncompress(buffer, function (err, buffer) {
            if (err) {
              job.warn(`gbcache: unable to decompress file referenced by cache: ${cached_file} (${err})`);
              force_miss = true;
              file_entry.output_hash = 'invalid'; // if a later output matches the old hash, we *do* need to write it!
              return void next();
            }
            let found_hash = hash(buffer);
            if (found_hash !== file_entry.output_hash) {
              job.warn(`gbcache: corrupt file referenced by cache: ${cached_file}` +
                ` (expected: ${file_entry.output_hash}, found: ${found_hash})`);
              file_entry.output_hash = 'invalid'; // if a later output matches the old hash, we *do* need to write it!
              force_miss = true;
              return void next();
            }
            outputs.push({
              relative: file_entry.relative,
              contents: buffer,
            });
            next();
          });
        });
      }, function (err) {
        if (err || force_miss) {
          return void cacheMiss();
        }
        for (let ii = 0; ii < outputs.length; ++ii) {
          job.out(outputs[ii]);
        }
        ++cache_hit;
        cache_record.seen = true;
        done();
      });
    }
    checkDeps(function (deps_match) {
      let force_miss = cache_record.ver !== version || !deps_match;
      checkOutputs(force_miss);
    });
  }
  function finish() {
    if (cache_hit || cache_miss) {
      gb.debug(`  gbcache(${key}): ${cache_hit} hits, ${cache_miss} misses`);
    }

    if (Object.keys(new_index).length || do_cache_rebuild) {
      // assemble new index, write it out
      gb.info(`  gbcache(${key}): Updating cache...`);
      let unchanged = 0;
      for (let relative in index) {
        let old_entry = index[relative];
        let new_entry = new_index[relative];
        if (!new_entry) {
          // either an old file not in the input set, or a file that was not changed
          if (old_entry.ver !== version) {
            // must not exist anymore, otherwise we would have had a job run
          } else if (do_cache_rebuild && !old_entry.seen) {
            // Forcing a rebuild and we did not get a job for this entry, must have been pruned from input data
          } else {
            // must assume this is just an input file that has not changed - place it in the new index
            new_index[relative] = old_entry;
            ++unchanged;
          }
        } else {
          // have a new and old entry
          let all_unchanged = true;
          for (let ii = 0; ii < old_entry.outputs.length; ++ii) {
            let old_file = old_entry.outputs[ii];
            // Look for same file in new_entry
            let found = false;
            for (let jj = 0; jj < new_entry.outputs.length; ++jj) {
              let new_file = new_entry.outputs[jj];
              if (new_file.relative === old_file.relative) {
                if (new_file.output_hash === old_file.output_hash) {
                  // same, use it
                  delete new_file.contents;
                  delete new_file.needs_write;
                } // else: changed, write new contents, don't "prune" as the cache filename is unchanged
                found = true;
              }
            }
            if (!found) {
              all_unchanged = false;
            }
          }
          if (all_unchanged) {
            ++unchanged;
          }
        }
      }
      // Make directories
      if (!fs.existsSync(cache_root)) {
        fs.mkdirSync(cache_root);
      }
      if (!fs.existsSync(cache_folder)) {
        fs.mkdirSync(cache_folder);
      }
      // Write new files
      let new_outputs = 0;
      let all_outputs = {};
      for (let relative in new_index) {
        let new_entry = new_index[relative];
        for (let ii = 0; ii < new_entry.outputs.length; ++ii) {
          let new_file = new_entry.outputs[ii];
          let record_name = recordToFilename2(new_file);
          all_outputs[record_name] = true;
          if (new_file.needs_write) {
            gb.debug(`  gbcache(${key}): writing ${record_name}`);
            let buf = new_file.contents;
            if (record_name.endsWith('.gz')) {
              buf = gzipSync(buf);
            }
            fs.writeFileSync(record_name, buf);
            ++new_outputs;
            delete new_file.needs_write;
            delete new_file.contents;
          }
        }
      }
      // Write new index
      let keys = Object.keys(new_index);
      keys.sort();
      let index_txt = keys.map((relative) => {
        let record = new_index[relative];
        let line = [relative, version, inputHash(record)];
        for (let ii = 0; ii < record.outputs.length; ++ii) {
          let file_entry = record.outputs[ii];
          if (file_entry.relative === record.relative) {
            line.splice(3, 0, file_entry.output_hash);
          } else {
            line.push(file_entry.relative, file_entry.output_hash);
          }
        }
        return line.join(';');
      }).join('\n');
      fs.writeFileSync(cache_index_path, index_txt);

      // Finally, prune old files
      let existing_files = fs.readdirSync(cache_folder);
      let pruned = 0;
      for (let ii = 0; ii < existing_files.length; ++ii) {
        let filename = `${cache_folder}/${existing_files[ii]}`;
        if (!all_outputs[filename]) {
          gb.debug(`  gbcache(${key}): pruning ${filename}`);
          if (fs.existsSync(filename)) {
            try {
              fs.unlinkSync(filename);
              ++pruned;
            } catch (err) {
              gb.warn(`  gbcache(${key}): error deleting ${filename} (${err})`);
            }
          }
        }
      }

      gb.info(`  gbcache(${key}): ${new_outputs} new, ${pruned} pruned, ${unchanged} unchanged`);

      // TODO: add command line option where we force a version change, so as to
      //   force all files to be processed, so that we can prune files which no
      //   longer exist in the input.
    }

    do_cache_rebuild = false; // Only valid the very first run in the process, not for --watch
  }

  return {
    ...task_opts,
    init,
    func,
    finish,
    version: do_cache_rebuild ? Date.now() : [
      version,
      init,
      func,
      finish,
    ],
  };
};
