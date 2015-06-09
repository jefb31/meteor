var less = Npm.require('less');
var util = Npm.require('util');
var path = Npm.require('path');
var Future = Npm.require('fibers/future');
var LRU = Npm.require('lru-cache');

Plugin.registerCompiler({
  extensions: ['less'],
  archMatching: 'web'
}, function () {
    return new LessCompiler();
});

var CACHE_SIZE = process.env.METEOR_LESS_CACHE_SIZE || 1024*1024*10;
var PRINT_ON_CACHE_MISS = !! process.env.METEOR_TEST_PRINT_ON_CACHE_MISS;

var LessCompiler = function () {
  var self = this;
  // XXX BBP doc
  // absoluteImportPath -> { hashes, css, sourceMap }
  //   where hashes is a map from absoluteImportPath -> hash of all
  //   paths used by it (including it itself)
  self._cache = new LRU({
    max: CACHE_SIZE,
    // Cache is measured in bytes (not counting the hashes).
    length: function (value) {
      return value.css.length + value.sourceMap.length;
    }
  });
  // For testing.
  self._callCount = 0;
};
_.extend(LessCompiler.prototype, {
  processFilesForTarget: function (inputFiles) {
    var self = this;
    var filesByAbsoluteImportPath = {};
    var mains = [];
    var cacheMisses = [];

    inputFiles.forEach(function (inputFile) {
      var packageName = inputFile.getPackageName();
      var pathInPackage = inputFile.getPathInPackage();
      // XXX BBP think about windows slashes
      var absoluteImportPath = packageName === null
            ? ('{}/' + pathInPackage)
            : ('{' + packageName + '}/' + pathInPackage);
      filesByAbsoluteImportPath[absoluteImportPath] = inputFile;
      if (pathInPackage.match(/\.main\.less$/)) {
        mains.push({inputFile: inputFile,
                    absoluteImportPath: absoluteImportPath});
      }
    });

    var importPlugin = new MeteorImportLessPlugin(filesByAbsoluteImportPath);

    mains.forEach(function (main) {
      var inputFile = main.inputFile;
      var absoluteImportPath = main.absoluteImportPath;

      var cacheEntry = self._cache.get(absoluteImportPath);
      if (! (cacheEntry &&
             self._cacheEntryValid(cacheEntry, filesByAbsoluteImportPath))) {
        cacheMisses.push(inputFile.getDisplayPath());
        var f = new Future;
        less.render(inputFile.getContentsAsBuffer().toString('utf8'), {
          filename: absoluteImportPath,
          plugins: [importPlugin],
          // Generate a source map, and include the source files in the
          // sourcesContent field.  (Note that source files which don't
          // themselves produce text (eg, are entirely variable definitions)
          // won't end up in the source map!)
          sourceMap: { outputSourceFiles: true }
        }, f.resolver());
        try {
          var output = f.wait();
        } catch (e) {
          inputFile.error({
            message: e.message,
            sourcePath: e.filename,  // XXX BBP this has {} and stuff, is that OK?
            line: e.line,
            column: e.column
          });
          return;  // go on to next file
        }
        cacheEntry = {
          hashes: {},
          css: output.css,
          sourceMap: output.map
        };
        // Make this cache entry depend on the hash of the file itself...
        cacheEntry.hashes[absoluteImportPath] = inputFile.getSourceHash();
        // ... and of all files it (transitively) imports, helpfully provided
        // to us by less.render.
        output.imports.forEach(function (path) {
          if (! filesByAbsoluteImportPath.hasOwnProperty(path)) {
            throw Error("Imported an unknown file?");
          }
          var importedInputFile = filesByAbsoluteImportPath[path];
          cacheEntry.hashes[path] = importedInputFile.getSourceHash();
        });
        // Override existing cache entry, if any.
        self._cache.set(absoluteImportPath, cacheEntry);
      }

      inputFile.addStylesheet({
        data: cacheEntry.css,
        path: inputFile.getPathInPackage() + '.css',
        sourceMap: cacheEntry.sourceMap
      });
    });
    if (PRINT_ON_CACHE_MISS) {
      cacheMisses.sort();
      console.log("Ran less.render (#%s) on: %s",
                  ++self._callCount, JSON.stringify(cacheMisses));
    }
  },
  _cacheEntryValid: function (cacheEntry, filesByAbsoluteImportPath) {
    var self = this;
    return _.all(cacheEntry.hashes, function (hash, path) {
      return _.has(filesByAbsoluteImportPath, path) &&
        filesByAbsoluteImportPath[path].getSourceHash() === hash;
    });
  }
});

var MeteorImportLessPlugin = function (filesByAbsoluteImportPath) {
  var self = this;
  self.filesByAbsoluteImportPath = filesByAbsoluteImportPath;
};
_.extend(MeteorImportLessPlugin.prototype, {
  install: function (less, pluginManager) {
    var self = this;
    pluginManager.addFileManager(
      new MeteorImportLessFileManager(self.filesByAbsoluteImportPath));
  },
  minVersion: [2, 5, 0]
});

var MeteorImportLessFileManager = function (filesByAbsoluteImportPath) {
  var self = this;
  self.filesByAbsoluteImportPath = filesByAbsoluteImportPath;
};
util.inherits(MeteorImportLessFileManager, less.AbstractFileManager);
_.extend(MeteorImportLessFileManager.prototype, {
  // We want to be the only active FileManager, so claim to support everything.
  supports: function () {
    return true;
  },

  loadFile: function (filename, currentDirectory, options, environment, cb) {
    var self = this;
    var packageMatch = currentDirectory.match(/^(\{[^}]*\})/);
    if (! packageMatch) {
      // shouldn't happen.  all filenames less ever sees should involve this {}
      // thing!
      throw new Error("file without Meteor context? " + currentDirectory);
    }
    var currentPackagePrefix = packageMatch[1];

    if (filename[0] === '/') {
      // Map `/foo/bar.less` onto `{thispackage}/foo/bar.less`
      filename = currentPackagePrefix + filename;
    } else if (filename[0] !== '{') {
      filename = path.join(currentDirectory, filename);
    }
    if (! _.has(self.filesByAbsoluteImportPath, filename)) {
      // XXX BBP better error handling?
      cb({type: "File", message: "Unknown import: " + filename});
      return;
    }
    cb(null, {
      contents: self.filesByAbsoluteImportPath[filename]
        .getContentsAsBuffer().toString('utf8'),
      filename: filename
    });
    return;
  }
});

