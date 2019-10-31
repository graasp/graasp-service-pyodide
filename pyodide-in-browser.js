/*

Test of pyodide, with
    - stdout and stderr collected and displayed in a pre element
    - error message sent to stderr
    - last result displayed with sys.displayhook
    - dynamic loading of modules referenced by import statements
    - file support
    - matplotlib support

Author: Yves Piguet, EPFL, 2019

Usage:
    const options = {
        btnRunId: "id of button to run code",  // else call p.run(src)
        btnClearId: "id of button to clear output",  // else call p.clear()
            // or call p.clearFigure() and p.clearText()
        srcId: "id of element with source code in value",
        outputId: "id of element whose textContent receives text output",
        write: function (str) { /* write text output ** },
            // alternative to outputId
        clearText: function () { /* clear text output ** },
            // alternative to outputId
        figureId: "id of image which shows graphical output",
        showFigure: function (dataURL) { /* show graphical output ** },
            // alternative to figureId
        clearFigure: function () { /* clear graphical output ** },
            // alternative to figureId
    };
    const p = new Pyodide(options);
    p.load();
    p.run(src);  // or rely on btnRunId passed as an option to Pyodide constructor
    ...
    let dirtyFilePaths = p.getDirtyFilePaths();
    // fetch dirtyFilePaths in sessionStorage and save them, upon page unload
    // or periodically
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
        this.write = options && options.write ||
            ((str) => {
                if (this.elOutput) {
                    this.elOutput.textContent += str;
                }
            });
        this.clearText = options && options.clearText ||
            (() => {
                if (this.elOutput) {
                    this.elOutput.textContent = "";
                }
            });
        this.figure = options && options.figureId
            ? document.getElementById(options.figureId)
            : null;
        this.setFigureURL = options && options.setFigureURL ||
            ((url) => {
                if (this.figure) {
                    this.figure.src = url;
                }
            });
        this.clearFigure = options && options.clearFigure ||
            (() => {
                if (this.moduleNames.indexOf("matplotlib") >= 0) {
                    pyodide.runPython(`
                        import matplotlib.pyplot
                        matplotlib.pyplot.clf()
                    `);
                    const transp1by1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
                    this.setFigureURL(transp1by1);
                }
            });

        this.moduleNames = [];
        this.dirtyFiles = [];

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
                addModuleName: (name) => this.addModuleName(name),
                markFileDirty: (path) => this.markFileDirty(path)
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
                            pyodideGlobal.markFileDirty(self.filename)
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
                this.btnClear.addEventListener("click", () => this.clear());
            }
        });
    }

    addModuleName(name) {
        if (this.moduleNames.indexOf(name) < 0) {
            this.moduleNames.push(name);
        }
    }

    markFileDirty(path) {
        if (this.dirtyFiles.indexOf(path) < 0) {
            this.dirtyFiles.push(path);
        }
    }

    getDirtyFilePaths() {
        return this.dirtyFiles;
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
            self.pyodideGlobal.setFigureURL = (url) => this.setFigureURL(url);
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
        this.write(stdout + errMsg);

        if (this.btnRun) {
            this.btnRun.disabled = false;
        }
        if (this.btnClear) {
            this.btnClear.disabled = false;
        }
    }

    clear() {
        this.clearText();
        this.clearFigure();
    }
}
