/*

Test of pyodide, with
	- stdout and stderr collected and displayed in a pre element
	- error message sent to stderr
	- last result displayed with sys.displayhook
	- dynamic loading of modules referenced by import statements
	- runs asynchronously in a webworker, with timeout and interruption

Messages sent from main thread to webworker: json, {cmd:string,...}, with:
- cmd="run": code=Python source code to be executed, or null/undefined to load at startup
- cmd="submit": str=string provided by the user
- cmd="get": path=path of file to be sent back with {cmd:"file",data:content}
- cmd="put": path=path of file to be stored in fs, data=content
- cmd="clearFigure"

Messages sent from webworker to main thread: json, {cmd:string,...}, with:
- cmd="clear": clear output
- cmd="cmd:xxx": additional command with data sent by sendCommand
- cmd="done": sent once execution is completed
- cmd="dirty": data=path of file which has been modified
- cmd="figure": data=dataurl
- cmd="file": path=string, data=string=file content, reply to cmd="get"
- cmd="input": prompt=string or null, expect a message back with cmd="submit"
- cmd="print": data=string to be appeded to the output

Author: Yves Piguet, EPFL, 2019-2020

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

importScripts("pyodide-class.js", "pyodide-build-0.14.1/pyodide.js");

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
    notifyStatus: (status) => {
        postMessage({cmd: "status", status: status});
    },
    notifyDirtyFile: (path) => {
        postMessage({cmd: "dirty", data: path});
    },
    postExec: function () {
        updateOutput(true);
        postMessage({cmd: "done"});
        if (p.requestInput) {
            postMessage({cmd: "input", prompt: p.inputPrompt});
        }
    },
    handleInput: true
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
    postMessage({cmd: "status", status: "running"});
    p.run(src);
}

function submitInput(str) {
    p.submitInput(str);
}

function cancelInput(str) {
    p.cancelInput();
}

onmessage = (ev) => {
    let msg = JSON.parse(ev.data);
    switch (msg.cmd) {
    case "preload":
        postMessage({cmd: "status", status: "startup"});
        p.load(() => {
            loaded = true;
            postMessage({cmd: "done"});
        });
        break;
    case "run":
    	if (loaded) {
    		run(msg.code);
    	} else {
            postMessage({cmd: "status", status: "startup"});
            p.load(() => {
                run(msg.code);
                loaded = true;
            });
    	}
        break;
    case "submit":
        submitInput(msg.str);
        break;
    case "cancel":
        cancelInput();
        break;
    case "get":
        postMessage({cmd: "file", path: msg.path, data: p.fs.getFile(msg.path)});
        break;
    case "put":
        p.fs.setFile(msg.path, msg.data);
        break;
    case "clearFigure":
        p.clearFigure();
        break;
    }

}
