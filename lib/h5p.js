/**
 * Requirements
 */
var http = require('http');
var child = require('child_process');
var fs = require('fs');
var archiver = require('archiver');

/**
 * Local globals
 */
var apiVersion = 1;
var registry;
var collection; // A collection is used to avoid circular dependencies
var pullushers; // A collection ready for pushing or pulling
var env = process.env;
env['GIT_SSH'] = __dirname + '/../bin/h5p-ssh';
// TODO: Try to start ssh-agent if env['SSH_AUTH_SOCK'] is missing?

/**
 * Make ssh errors short and understandable.
 */
function sshError(error, url) {
  if (error.indexOf('Host key verification failed.') !== -1) error = 'Host key verification failed.' + (url ? ' Try running ssh -T ' + url.split(':', 1)[0] : '') + '\n';
  if (error.indexOf('Permission denied') !== -1) error = 'Permission denied.\nMake sure ssh-agent is running.' + (url ? ' (ssh -T ' + url.split(':', 1)[0] + ' should not ask for password/passphrase)' : '') + '\n';
  return error;
}

/**
 * Skip ssh warnings.
 * (typically comes when a host has multiple IPs, like github.com)
 */
function skipWarnings(output) {
  if (output.substr(0, 8) === 'Warning:' || output.substr(0, 12) === 'Cloning into') output = '';
  return output;
}

/**
 * Run given callback with h5p registry as params.
 */
function getRegistry(next) {
  if (registry) return next(null, registry.libraries);
  
  http.get('http://h5p.org/registry.json', function (response) {
    if (response.statusCode !== 200) {
      return next('Server responded with HTTP ' + response.statusCode + '.');
    }
    
    var jsonBuffer = '';
    response.on('data', function (chunk) {
      jsonBuffer += chunk;
    });
    
    response.on('end', function () {
      try {
        registry = JSON.parse(jsonBuffer);
      }
      catch (error) {
        return next('Cannot parse registry information: ' + error.message);
      }
      
      if (registry.apiVersion !== apiVersion) return next('API Version mismatch.\nMake sure this tool is up to date.');
      
      next(null, registry.libraries);
    });
  }).on('error', function (error) {
    return next('Cannot connect to server: ' + error.message);
  });
}

/**
 * Recursive function that adds the given library + its dependencies to the collection.
 */
function getLibrary(libraryName, next) {
  if (libraryName === '') return next();
  getRegistry(function (error, libraries) {
    if (error) return next(error);
    if (collection[libraryName]) return next(); // Already have this.
    
    var library = libraries[libraryName];
    if (!library) return next('No such library.');

    collection[libraryName] = library;
    
    if (library.dependencies) {
      // Find dependencies
      var errors = '';
      var loaded = 0;
      
      for (var i = 0; i < library.dependencies.length; i++) {
        dependency = library.dependencies[i];
        getLibrary(dependency, function (error) {
          if (error) errors += '\n' + dependency + ': ' + error;
          loaded++;
              
          if (loaded === library.dependencies.length) {
            next(errors === '' ? null : errors);
          }
        });
      } 
    }
    else {
      next();
    }
  });
};

/**
 * Clone repo at given url into given dir.
 */
function cloneRepository(dir, url, next) {
  var proc = child.spawn('git', ['clone', url, dir], {env: env});
  proc.on('error', function (error) {
    next(error);
  });
  
  var output = '';
  proc.stderr.on('data', function (data) {
    output += skipWarnings(data.toString());
  });
  proc.stderr.on('end', function () {
    if (output.indexOf('already exists') !== -1) return next(-1);
    next(sshError(output, url));
  });
}

/**
 * Check if dir is a repo.
 */
function checkRepository(dir, next) {
  fs.stat(dir + '/.git/config', function (error, stats) {
    if (error) return next(null);
    next(dir);
  });
}

/**
 * Find all repos in the current working dir.
 */
function findRepositories(next) {
  fs.readdir('.', function (error, files) {
    if (error) return next(error);
    
    var repos = [];
    var processed = 0;
    for (var i = 0; i < files.length; i++) {
      checkRepository(files[i], function (repo) {
        if (repo) {
          repos.push(repo);
        }
        
        processed++;
        if (processed === files.length) {
          next(null, repos);
        }
      });
    }
  });
}

/**
 * Find status lines for the given repo.
 */
function statusRepository(dir, next) {
  var status = {
    name: dir
  };
  
  var proc = child.spawn('git', ['status', '--porcelain', '--branch'], {cwd: process.cwd() + '/' + dir, env: env});
  
  proc.on('error', function (error) {
    status.error = error;
    next(status);
  });
  
  var buffer = '';
  proc.stdout.on('data', function (data) {
    buffer += data.toString();
  });
  
  proc.stdout.on('end', function () {
    var lines = buffer.split('\n');
    lines.pop(); // Empty

    status.branch = lines.shift().split('## ')[1];
    if (lines.length) {
      status.changes = lines;
    }
    
    next(status);
  });
}

/**
 * Stage and commit all on the given repo.
 */
function commitRepository(dir, message, next) {
  var result = {
    name: dir
  };
  
  var procOpts = {cwd: process.cwd() + '/' + dir, env: env};
  
  var proc = child.spawn('git', ['add', '--all'], procOpts);
  
  proc.on('error', function (error) {
    result.error = error;
    next(result);
  });
  
  proc.on('exit', function (code) {
    if (code !== 0) {
      result.error = 'Exit code ' + code;
      return next(result);
    }
    
    // Everything staged. Commit!
    var proc = child.spawn('git', ['commit', '-m', message], procOpts);
    
    proc.on('error', function (error) {
      result.error = error;
      next(result);
    });
  
    var buffer = '';
    proc.stdout.on('data', function (data) {
      buffer += data.toString();
    });
  
    proc.stdout.on('end', function () {
      var lines = buffer.split('\n');
      lines.pop(); // Empty

      var line = lines.shift().replace(/\[|\]/g, '').split(' ', 3);
      if (line[0] !== '#') {
        result.branch = line[0];
        result.commit = line[1];
        result.changes = lines;
      }

      next(result);
    });
    
  });
}

/**
 * Pull the current branch for the given repo.
 */
function pullRepository(dir, next) {
  var proc = child.spawn('git', ['pull', 'origin', 'HEAD'], {cwd: process.cwd() + '/' + dir, env: env});
  proc.on('error', function (error) {
    next(error);
  })
    
  var output = '';
  proc.stderr.on('data', function (data) {
    output += skipWarnings(data.toString());
  });
  proc.stderr.on('end', function () {
    if (output.substr(0, 4) === 'From') return next();
    next(sshError(output));
  });
}

/**
 * Pull the current branch for the given repo.
 */
function pushRepository(dir, next) {
  var proc = child.spawn('git', ['push', 'origin', 'HEAD'], {cwd: process.cwd() + '/' + dir, env: env});
  proc.on('error', function (error) {
    next(error);
  })

  var output = '';  
  proc.stderr.on('data', function (data) {
    output += skipWarnings(data.toString());
  });
  
  proc.stderr.on('end', function () {
    var res = output.substr(0, 2);
    if (res === 'Ev') return next(-1);
    if (res === 'To') return next(null, output.split('\n')[1].replace(/(^\s+|\s+$)/g, '').replace(/\s{2,}/g, ' '));
    
    next(sshError(output));
  });
}

/**
 * Get the diff for the given repo.
 */
function diffRepository(dir, next) {
  var proc = child.spawn('git', ['diff'], {cwd: process.cwd() + '/' + dir});
  proc.on('error', function (error) {
    next(error);
  });
 
  var buffer = ''; 
  proc.stdout.on('data', function (data) {
    buffer += data.toString();
  });
  proc.stdout.on('end', function () {
    // Update file paths.
    buffer = buffer.replace(/\n(---|\+\+\+) (a|b)\/(.+)/g, '\n$1 $2/' + dir + '/$3').replace(/(^|\n)(diff --git a\/)(.+ b\/)(.+)/g, '$1$2' + dir + '/$3' + dir + '/$4');
    
    next(null, buffer)
  });
}

/**
 * Load data for each library and execute next callback sync.
 */
function loadLibraries(libraries, next) {
  try {
    for (var i = 0; i < libraries.length; i++) {
      var dir = libraries[i];
      var library = JSON.parse(fs.readFileSync(dir + '/library.json'));
      next(null, library, dir);
    } 
  }
  catch (err) {
    return next(err);
  }
}

/**
 * Recursive archiving of the given path.
 */
function archiveDir(archive, path, alias) {
  if (alias === undefined) alias = path;
  
  var files = fs.readdirSync(path)
  for (var i = 0; i < files.length; i++) {
    var filename = files[i];
    var file = path + '/' + filename;
    var target = alias + '/' + filename;
    
    // Skip hidden files and tmp files.
    if (filename.match(process.env.H5P_IGNORE_PATTERN !== undefined ? new RegExp(process.env.H5P_IGNORE_PATTERN, process.env.H5P_IGNORE_MODIFIERS) : /^\.|~$/gi) !== null) {
      continue;
    }
    
    if (fs.lstatSync(file).isDirectory()) {
      archiveDir(archive, file, target);
    }
    else {
      archive.append(fs.createReadStream(file), {name: target});
    }
  }
}

/**
 * Export our api.
 */
var h5p = module.exports = {};

/**
 * Return list of libraries.
 */
h5p.list = function (next) {
  getRegistry(function (error, libraries) {
    next(error, libraries);    
  });
}

/**
 * Creates a new collection and fills it up with the given library and its dependencies.
 */
h5p.get = function (libraries, next) {
  collection = {}; // Start a new collection

  var loop = function (i) {
    getLibrary(libraries[i], function (error) {
      i += 1;
      if (i === libraries.length) return next(error);
      loop(i);
    });
  }
  loop(0);
}

/**
 * Clone the next library in the collection.
 */
h5p.clone = function (next) {
  for (lib in collection) {
    cloneRepository(lib, collection[lib].repository, next); 
    delete collection[lib];
    return lib;
  }
  return false;
}

/**
 * Display status of all checkout libraries.
 */
h5p.status = function (next) {
  findRepositories(function (error, repos) {
    if (error) return next(error);
    
    var results = [];
    for (var i = 0; i < repos.length; i++) {
      statusRepository(repos[i], function (status) {
        results.push(status);
        if (results.length === repos.length) {
          next(null, results);
        }
      });
    }
  });
}

/**
 * Commit all changes to all libraries.
 */
h5p.commit = function (message, next) {
  findRepositories(function (error, repos) {
    if (error) return next(error);
    
    var results = [];
    for (var i = 0; i < repos.length; i++) {
      commitRepository(repos[i], message, function (result) {
        results.push(result);
        if (results.length === repos.length) {
          next(null, results);
        }
      });
    }
  });
}

/**
 * Will prepare a collection of repos for pushing/pulling.
 */
h5p.update = function (next) {
  pullushers = []; // Start a new collection

  findRepositories(function (error, repos) {
    if (error) return next(error);
    
    pullushers = repos;
    next();
  });
}

/**
 * Pull the next library in the collection.
 */
h5p.pull = function (next) {
  var repo = pullushers.shift();
  if (!repo) return false;
 
  pullRepository(repo, next); 
  return repo;
}

/**
 * Push the next library in the collection.
 */
h5p.push = function (next) {
  var repo = pullushers.shift();
  if (!repo) return false;
 
  pushRepository(repo, next); 
  return repo;
}

/**
 * Get diffs for all repos.
 */
h5p.diff = function (next) {
  findRepositories(function (error, repos) {
    if (error) return next(error);
    
    var diffs = '', done = 0;
    for (var i = 0; i < repos.length; i++) {
      diffRepository(repos[i], function (error, diff) {
        if (error) return next(error);

        diffs += diff;
        
        if (done++ === repos.length - 1) next(null, diffs);
      });
    }
  });
}

/**
 * Pack the given libraries in a .h5p file
 */
h5p.pack = function (libraries, next) {
  var output = fs.createWriteStream('libraries.h5p');
  var archive = archiver('zip');

  output.on('close', function () {
    next();
  });

  archive.on('error', function (err) {
    next(err);
  });

  archive.pipe(output);
  
  loadLibraries(libraries, function (err, library, dir) {
    if (err) return next(err);
    archiveDir(archive, dir, library.machineName + '-' + library.majorVersion + '.' + library.minorVersion);
  });
  
  archive.finalize();
}

/**
 * Pack the given libraries in a .h5p file
 */
h5p.increasePatchVersion = function (libraries, next) {
  var error;
  loadLibraries(libraries, function (err, library, dir) {
    if (err) return error = err;
    library.patchVersion++;
    fs.writeFileSync(dir + '/library.json', JSON.stringify(library, null, 2));
  });
  next(error);
}

// TODO: Add pre-commit hook?
var preCommit = '#!/bin/sh\
\
h5p=$(which h5p)\
if [ ! -f "$h5p" ]; then\
  echo "Missing h5p command. Patch version not increased."\
else\
  lib=${PWD##*/}\
  cd .. && "$h5p" increase-patch-version "$lib"\
  cd "$lib" && git add .\
fi'

