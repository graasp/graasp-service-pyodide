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

importScripts("pyodide-class.js", "pyodide.js");

var loaded = false;

let outputClear = false;
let outputBuffer = "";
let pendingOutputFlushTime = -1;
const outputUpdateRate = 10;	// ms

const options = {
    write: (str) => {
	   outputBuffer += str;
    },
    clearText: () => {
    	outputBuffer = "";
    	outputClear = true;
    },
    setFigureURL: (dataURL) => {
        postMessage({cmd: "figure", data: dataURL});
    },
    ready: () => {
	   updateOutput(true);
	   postMessage({cmd: "done"});
    }
};
const p = new Pyodide(options);


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

function run(src) {
	if (src) {
        p.run(src);
	}
}

onmessage = (ev) => {
	let src = ev.data;

	if (loaded) {
		run(src);
	} else {
        p.load(() => run(src));
	}

}
