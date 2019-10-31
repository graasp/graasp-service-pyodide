/*

Test of pyodide, with
	- stdout and stderr collected and displayed in a pre element
	- error message sent to stderr
	- last result displayed with sys.displayhook
	- dynamic loading of modules referenced by import statements
	- file support
	- matplotlib support

Author: Yves Piguet, EPFL, 2019

*/

class Pyodide {
    constructor(options) {
        this.btnRun = options && options.btnRunId
            ? document.getElementById(options.btnRunId)
            : null;
        this.btnClear = options && options.btnClearId
            ? document.getElementById(options.btnClearId)
            : null;
        this.elSrc = options && options.srcId
            ? document.getElementById(options.srcId)
            : null;
        this.elOutput = options && options.outputId
            ? document.getElementById(options.outputId)
            : null;
        this.figure = options && options.figureId
            ? document.getElementById(options.figureId)
            : null;

        this.moduleNames = [];

        if (this.elSrc) {
			// editor tab key
			this.elSrc.addEventListener("keydown", (ev) => {
				if (ev.keyCode === 9) {
					// prevent loss of focus in textarea
					ev.preventDefault();
					ev.cancelBubbles = true;
					let text = this.elSrc.value;
					let start = this.elSrc.selectionStart, end = this.elSrc.selectionEnd;
					text = text.slice(0, start) + "\t" + text.slice(end);
					this.elSrc.value = text;
					this.elSrc.selectionStart = this.elSrc.selectionEnd = start + 1;
					return false;
				} else if ((ev.keyCode === 13 || ev.key === "Enter") && ev.shiftKey) {
					// run
					ev.preventDefault();
					ev.cancelBubbles = true;
					this.run();
					return false;
				}
				// normal behavior
				return true;
			}, false);
        }
    }

    load() {
		languagePluginLoader.then(() => {

			self.pyodideGlobal = {
                addModuleName: (name) => this.addModuleName(name)
            };

            pyodide.runPython(`
				import sys
				from js import pyodideGlobal
				class __ImportIntercept:
					def find_spec(self, name, path, module):
						pyodideGlobal.addModuleName(name)
				sys.meta_path.append(__ImportIntercept())

				import io
				import js

				class MyTextFile(io.StringIO):
					def __init__(self, filename, mode="r"):
						self.filename = filename
						self.readOnly = mode == "r"
						content = js.sessionStorage.getItem(filename)
						if content is None:
							if self.readOnly:
								raise FileNotFoundError(filename)
							content = ""
						else:
							if mode == "w":
								content = ""
							elif mode == "x":
								raise FileExistsError(filename)
						super().__init__(content if content is not None else "")
						if mode == "a":
							self.seek(0, 2)
					def close(self):
						if not self.readOnly:
							content = self.getvalue()
							js.sessionStorage.setItem(self.filename, content)
							super().close()

				global open
				def open(filename, mode="r", encoding=None):
					return MyTextFile(filename, mode)

				import os

				def __os_listdir(path="."):
					return list(js.Object.keys(js.sessionStorage))
				os.listdir = __os_listdir
			`);

            if (this.btnRun) {
                this.btnRun.disabled = false;
                this.btnRun.addEventListener("click", () => this.run());
            }
            if (this.btnClear) {
                this.btnClear.disabled = false;
                this.btnClear.addEventListener("click", () => {
    				if (this.elOutput) {
                        this.elOutput.textContent = "";
                    }
    				this.clearFigure();
    			});
            }
		});
    }

    addModuleName(name) {
		if (this.moduleNames.indexOf(name) < 0) {
			this.moduleNames.push(name);
		}
    }

    setFigureURL(url) {
        if (this.figure) {
            document.getElementById("figure").src = url;
        }
    }

    run(src) {
		this.btnRun && (this.btnRun.disabled = true);
		this.btnClear && (this.btnClear.disabled = true);

		// (re)set stdin and stderr
		pyodide.runPython(`
			import io, sys
			sys.stdout = io.StringIO()
			sys.stderr = sys.stdout
		`);

        if (src == undefined) {
            src = this.elSrc.value;
        }
		let errMsg = "";
		let moduleNamesLen0 = this.moduleNames.length;
		try {
			self.pyodideGlobal = {
                setFigureURL: (url) => this.setFigureURL(url)
            };
            self.pyodideGlobal.runPythonOutput = pyodide.runPython(src);

			pyodide.runPython(`
				from js import pyodideGlobal
				import sys
				sys.displayhook(pyodideGlobal.runPythonOutput)
			`);
			if (this.moduleNames.indexOf("matplotlib") >= 0) {
				pyodide.runPython(`
					import matplotlib.pyplot, io, base64, js
					with io.BytesIO() as buf:
						matplotlib.pyplot.savefig(buf, format="png")
						buf.seek(0)
						js.pyodideGlobal.setFigureURL("data:image/png;base64," +
							base64.b64encode(buf.read()).decode("ascii"))
				`);
			}
		} catch (err) {
			if (/ModuleNotFoundError/.test(err.message) &&
				this.moduleNames.length > moduleNamesLen0) {
				pyodide.loadPackage(this.moduleNames)
					.then(() => {
						this.run();
					});
			} else {
				errMsg = err.message;
			}
		}

		let stdout = pyodide.runPython("sys.stdout.getvalue()");
        if (this.elOutput) {
		  this.elOutput.textContent += stdout + errMsg;
        }

        if (this.btnRun) {
            this.btnRun.disabled = false;
		}
        if (this.btnClear) {
            this.btnClear.disabled = false;
        }
    }

    clearFigure() {
    	if (moduleNames.indexOf("matplotlib") >= 0) {
    		pyodide.runPython(`
    			import matplotlib.pyplot
    			matplotlib.pyplot.clf()
    		`);
    		self.setFigureURL("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");
    	}
    }
}
