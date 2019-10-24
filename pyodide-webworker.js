/*

Test of pyodide, with
	- stdout and stderr collected and displayed in a pre element
	- error message sent to stderr
	- last result displayed with sys.displayhook
	- dynamic loading of modules referenced by import statements
	- runs asynchronously in a webworker, with timeout and interruption

Author: Yves Piguet, EPFL, 2019

*/

/*

Patch for pyodide.js:

YP/2019-Aug-29
replace line 11
  baseURL = baseURL.substr(0, baseURL.lastIndexOf('/')) + '/';
with
  baseURL = baseURL && baseURL.substr(0, baseURL.lastIndexOf('/')) + '/';
to support url without slash (otherwise baseURL would wrongly become absolute)

Make sure that .wasm is served with mime type application/wasm
(in apache2: /etc/apache2/mime.types)

*/

importScripts("pyodide.js");

var loaded = false;

let outputClear = false;
let outputBuffer = "";
let pendingOutputFlushTime = -1;
const outputUpdateRate = 10;	// ms

let moduleNames = [];
self.addModuleName = function (name) {
	if (moduleNames.indexOf(name) < 0) {
		moduleNames.push(name);
	}
};

function writeToOutput(str) {
	outputBuffer += str;
}

function clearOutput() {
	outputBuffer = "";
	outputClear = true;
}

function updateOutput(forced) {
	let currentTime = Date.now();
	if (forced) {
		pendingOutputFlushTime = currentTime;
	}
	if (pendingOutputFlushTime < 0) {
		// schedule flush
		pendingOutputFlushTime = currentTime + outputUpdateRate;
	} else if (pendingOutputFlushTime <= currentTime) {
		// time to flush
		if (outputClear) {
			postMessage({cmd: "clear"});
			outputClear = false;
		}
		if (outputBuffer) {
			postMessage({cmd: "print", data: outputBuffer});
			outputBuffer = "";
		}
		pendingOutputFlushTime = -1;
	}
}

function sendCommand(cmd, data) {
	postMessage({cmd: "cmd:" + cmd, data: data})
}

function input(prompt) {
	writeToOutput(prompt);
	postMessage({cmd: "input"});
	var promise = new Promise((resolve, reject) => {
		console.info(resolve);
		console.info(reject);
	});
	return promise;
}

function run(src) {
	if (src) {
		pyodide.runPython(`
			import io, sys, js
			class __StringNotifierIO(io.TextIOBase):
				def write(self, s):
					js.writeToOutput(s)
					js.updateOutput()
					return len(s)

			sys.stdout = __StringNotifierIO()
			sys.stderr = sys.stdout
		`);

		let moduleNamesLen0 = moduleNames.length;
		try {
			self.runPythonOutput = pyodide.runPython(src);
			pyodide.runPython(`
				from js import runPythonOutput
				import sys
				sys.displayhook(runPythonOutput)
			`);
		} catch (err) {
			if (/ModuleNotFoundError/.test(err.message) &&
				moduleNames.length > moduleNamesLen0) {
				pyodide.loadPackage(moduleNames)
					.then(() => {
						run(src);
					});
			} else {
				writeToOutput(err.message);
			}
		}

		updateOutput(true);

	}

	postMessage({cmd: "done"});
}

onmessage = (ev) => {

	let src = ev.data;

	if (loaded) {
		run(src);
	} else {
		languagePluginLoader.then(() => {
			loaded = true;

			pyodide.runPython(`
				import sys
				from js import addModuleName
				class __ImportIntercept:
					def find_spec(self, name, path, module):
						addModuleName(name)
				sys.meta_path.append(__ImportIntercept())
			`);

			run(src);
		});
	}

}
