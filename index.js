const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
  assert(!task_opts.init);
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

  function recordToFilename(record) {
    let fn = safeFilename(record.relative);
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
          let [relative, ver, input_hash, output_hash] = line;
          index[relative] = {
            relative,
            ver: Number(ver),
            input_hash,
            output_hash,
          };
        });
      }
      next();
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
          let output_queue = job.getOutputQueue();
          let output_keys = Object.keys(output_queue);
          assert.equal(output_keys.length, 1);
          let output_file = output_queue[output_keys[0]];
          let { contents, relative } = output_file;
          assert.equal(relative, file.relative);
          assert(Buffer.isBuffer(contents));
          if (do_cache_write) {
            let output_hash = hash(contents);
            new_index[relative] = {
              relative,
              ver: version,
              input_hash,
              output_hash,
              needs_write: true,
              contents,
            };
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
      let cached_file = recordToFilename(cache_record);
      fs.readFile(cached_file, function (err, buffer) {
        if (err) {
          job.warn(`gbcache: unable to load file referenced by cache: ${cached_file} (${err})`);
          return void cacheMiss();
        }
        let found_hash = hash(buffer);
        if (found_hash !== cache_record.output_hash) {
          job.warn(`gbcache: corrupt file referenced by cache: ${cached_file}` +
            ` (expected: ${cache_record.output_hash}, found: ${found_hash})`);
          return void cacheMiss();
        }
        ++cache_hit;
        cache_record.seen = true;
        job.out({
          relative: file.relative,
          contents: buffer,
        });
        done(err);
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
        if (!new_entry) {
          // either an old file not in the input set, or a file that was not changed
          if (old_entry.ver !== version) {
            // must not exist anymore, otherwise we would have had a job run
            to_prune.push(recordToFilename(old_entry));
          } else if (do_cache_rebuild && !old_entry.seen) {
            // Forcing a rebuild and we did not get a job for this entry, must be pruned from input data
            to_prune.push(recordToFilename(old_entry));
          } else {
            // must assume this is just an input file that has not changed - place it in the new index
            new_index[relative] = old_entry;
            ++unchanged;
          }
        } else {
          // have an old entry too
          if (old_entry.output_hash === new_entry.output_hash) {
            // nothing changed (except perhaps the version), use the old data
            delete new_entry.needs_write;
            delete new_entry.contents;
            ++unchanged;
          } else {
            // new entry, new data, will write new one to disk, prune old file
            to_prune.push(recordToFilename(old_entry));
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
        if (new_entry.needs_write) {
          fs.writeFileSync(recordToFilename(new_entry), new_entry.contents);
          ++new_files;
          delete new_entry.needs_write;
          delete new_entry.contents;
        }
      }
      // Write new index
      let keys = Object.keys(new_index);
      keys.sort();
      let index_txt = keys.map((relative) => {
        let record = new_index[relative];
        return [relative, version, record.input_hash, record.output_hash].join(';');
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
