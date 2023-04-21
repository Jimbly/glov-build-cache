const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { asyncEach } = require('glov-async');
const gb = require('glov-build');
const argv = require('minimist')(process.argv.slice(2));

function hash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function safeFilename(relative) {
  return relative.replace(/[^A-Za-z0-9_.-]/g, '_');
}

module.exports = function gbcache(cache_opts, task_opts) {
  let {
    key,
    version,
    cache_root,
    do_cache_write,
    do_cache_rebuild,
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

  cache_root = cache_root || path.resolve(gb.getSourceRoot(), '../.gbcache');
  let cache_folder = path.join(cache_root, key);
  let cache_index_path = path.join(cache_root, `${key}.index.txt`);
  let index;
  let new_index;

  function recordToFilename2(record, file_entry) {
    let fn = safeFilename(file_entry.relative);
    let ext_idx = fn.lastIndexOf('.');
    let ext = '';
    if (ext_idx !== -1) {
      ext = fn.slice(ext_idx);
      fn = fn.slice(0, ext_idx);
    }
    return path.join(cache_folder, `${fn}#${record.input_hash.slice(-7)}${ext}`);
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
          let [relative, ver, input_hash, ...outputs] = line;
          let entry = index[relative] = {
            relative,
            ver: Number(ver),
            input_hash,
            files: [],
          };
          if (outputs.length % 2) {
            // odd number, first entry must be identity name
            entry.files.push({
              relative,
              output_hash: outputs[0],
            });
            outputs.splice(0, 1);
          }
          for (let ii = 0; ii < outputs.length; ii += 2) {
            entry.files.push({
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

    let input_hash = hash(file.contents);
    function cacheMiss() {
      // run job, save output to cache if needed
      ++cache_miss;
      task_opts.func(job, function (err) {
        if (!err) {
          let new_entry;
          if (do_cache_write) {
            new_entry = new_index[file.relative] = {
              relative: file.relative,
              ver: version,
              input_hash,
              files: [],
            };
          }
          let output_queue = job.getOutputQueue();
          let output_keys = Object.keys(output_queue);
          for (let ii = 0; ii < output_keys.length; ++ii) {
            let outputkey = output_keys[ii];
            let output_file = output_queue[outputkey];
            let { contents, relative } = output_file;
            assert(Buffer.isBuffer(contents));
            if (do_cache_write) {
              let output_hash = hash(contents);
              new_entry.files.push({
                relative,
                output_hash,
                needs_write: true,
                contents,
              });
            }
          }
        }
        done(err);
      });
    }

    let cache_record = index[file.relative];
    if (cache_record &&
      cache_record.ver === version &&
      cache_record.input_hash === input_hash
    ) {
      // cache appears valid
      let outputs = [];
      asyncEach(cache_record.files, function (file_entry, next, idx) {
        let cached_file = recordToFilename2(cache_record, file_entry);
        fs.readFile(cached_file, function (err, buffer) {
          if (err) {
            job.warn(`gbcache: unable to load file referenced by cache: ${cached_file} (${err})`);
            return void next(err);
          }
          let found_hash = hash(buffer);
          if (found_hash !== file_entry.output_hash) {
            job.warn(`gbcache: corrupt file referenced by cache: ${cached_file}` +
              ` (expected: ${file_entry.output_hash}, found: ${found_hash})`);
            return void next('corrupt cache');
          }
          outputs.push({
            relative: file_entry.relative,
            contents: buffer,
          });
          next();
        });
      }, function (err) {
        if (err) {
          return void cacheMiss();
        }
        for (let ii = 0; ii < outputs.length; ++ii) {
          job.out(outputs[ii]);
        }
        ++cache_hit;
        cache_record.seen = true;
        done();
      });
    } else {
      cacheMiss();
    }
  }
  function finish() {
    if (cache_hit || cache_miss) {
      gb.debug(`  gbcache(${key}): ${cache_hit} hits, ${cache_miss} misses`);
    }

    if (Object.keys(new_index).length || do_cache_rebuild) {
      // assemble new index, write it out
      gb.info(`  gbcache(${key}): Updating cache...`);
      let to_prune = [];
      let unchanged = 0;
      for (let relative in index) {
        let old_entry = index[relative];
        let new_entry = new_index[relative];
        let prune_old = false;
        if (!new_entry) {
          // either an old file not in the input set, or a file that was not changed
          if (old_entry.ver !== version) {
            // must not exist anymore, otherwise we would have had a job run
            prune_old = true;
          } else if (do_cache_rebuild && !old_entry.seen) {
            // Forcing a rebuild and we did not get a job for this entry, must have been pruned from input data
            prune_old = true;
          } else {
            // must assume this is just an input file that has not changed - place it in the new index
            new_index[relative] = old_entry;
            ++unchanged;
          }
        } else {
          // have a new and old entry
          if (old_entry.input_hash === new_entry.input_hash) {
            // nothing changed (except perhaps the version), use the old data if appropriate
            let all_unchanged = true;
            for (let ii = 0; ii < old_entry.files.length; ++ii) {
              let old_file = old_entry.files[ii];
              // Look for same file in new_entry
              let found = false;
              for (let jj = 0; jj < new_entry.files.length; ++jj) {
                let new_file = new_entry.files[jj];
                if (new_file.relative === old_file.relative && new_file.output_hash === old_file.output_hash) {
                  // same, use it
                  delete new_file.contents;
                  delete new_file.needs_write;
                  found = true;
                }
              }
              if (!found) {
                all_unchanged = false;
                to_prune.push(recordToFilename2(old_entry, old_file));
              }
            }
            if (all_unchanged) {
              ++unchanged;
            }
          } else {
            // new entry, new data, will write new one to disk, prune old files
            prune_old = true;
          }
        }
        if (prune_old) {
          for (let ii = 0; ii < old_entry.files.length; ++ii) {
            to_prune.push(recordToFilename2(old_entry, old_entry.files[ii]));
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
      let new_files = 0;
      for (let relative in new_index) {
        let new_entry = new_index[relative];
        for (let ii = 0; ii < new_entry.files.length; ++ii) {
          let new_file = new_entry.files[ii];
          if (new_file.needs_write) {
            fs.writeFileSync(recordToFilename2(new_entry, new_file), new_file.contents);
            ++new_files;
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
        let line = [relative, version, record.input_hash];
        for (let ii = 0; ii < record.files.length; ++ii) {
          let file_entry = record.files[ii];
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
      let pruned = 0;
      for (let ii = 0; ii < to_prune.length; ++ii) {
        let filename = to_prune[ii];
        if (fs.existsSync(filename)) {
          try {
            fs.unlinkSync(filename);
            ++pruned;
          } catch (err) {
            gb.warn(`  gbcache(${key}): error deleting ${filename} (${err})`);
          }
        }
      }

      gb.info(`  gbcache(${key}): ${new_files} new, ${pruned} pruned, ${unchanged} unchanged`);

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
