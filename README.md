# Graasp Service: Pyodide

A compiled distribution of Pyodide for use in the Graasp ecosystem.

## Without Graasp

To install, copy the files below and the directory pyodide-build-0.14.1
which contains the pre-built Pyodide 0.14.1 distribution at
https://github.com/iodide-project/pyodide/releases/
somewhere on an http server. For another version, change Pyodide's
location in pyodide-webworker in importScripts, and the definition
of self.languagePluginUrl in pyodide-class.js.

For the non-webworker version running in the main browser thread:
pyodide-class.js pyodide-in-browser-lib-test.html 

For the webworker version:
pyodide-class.js pyodide-webworker.js pyodide-webworker-test.html
pyodide-webworker-master.js

## With Graasp

The functionality provided by the html files should be implemented
with Graasp hooks. The following files should be used, also with the
directory pyodide-build-0.14.1 which contains the pre-built Pyodide
0.14.1 distribution.

For the non-webworker version running in the main browser thread:
pyodide-class.js

For the webworker version:
pyodide-class.js pyodide-webworker.js pyodide-webworker-master.js

