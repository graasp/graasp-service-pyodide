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
        ready: function () { /* notify that running is finished ** },
        write: function (str) { /* write text output ** },
        clearText: function () { /* clear text output ** },
        setFigureURL: function (dataURL) { /* show graphical output ** },
        notifyDirtyFile: function (path) { /* notify that a file has been modified ** },
        handleInput: boolean /* see below **
    };
    const p = new Pyodide(options);
    p.load();   // optional arg: function called once everything is loaded
    p.run(src);
    ...
    let dirtyFilePaths = p.getDirtyFilePaths();
    // fetch dirtyFilePaths in sessionStorage and save them, upon page unload
    // or periodically

With option handleInput=true, some support for input function is provided.
It's limited to calls outside any function definition. The whole code is
compiled as a coroutine, replacing "input(...)" with "yield(...)",
and the function is executed as a coroutine, sending input string (first
None) and receiving prompt for next input until a StopIteration exception
is raised.

*/

/** Simple virtual file system
*/
class FileSystem {
    /** Create a FileSystem object with data stored in sessionStorage
        @return {FileSystem}
    */
    static create() {
        return self.sessionStorage
            ? new FileSystemSessionStorage()
            : new FileSystemJS();
    }
}

/** Simple virtual file system with data stored internally
*/
class FileSystemJS extends FileSystem {
    constructor() {
        super();
        this.fs = {};
    }

    getDir() {
        return Object.keys(this.fs);
    }

    getFile(filename) {
        return this.fs[filename];
    }

    setFile(filename, content) {
        this.fs[filename] = content;
    }
}

/** Simple virtual file system with data stored as separate entries in
    sessionStorage
*/
class FileSystemSessionStorage extends FileSystem {
    getDir() {
        return Object.keys(self.sessionStorage);
    }

    getFile(filename) {
        return self.sessionStorage.getItem(filename);
    }

    setFile(filename, content) {
        self.sessionStorage.setItem(filename, content);
    }
}

class Pyodide {
    constructor(options) {
        this.ready = options && options.ready || (() => {});
        this.write = options && options.write || ((str) => {});
        this.clearText = options && options.clearText || (() => {});
        this.setFigureURL = options && options.setFigureURL || ((url) => {});
        this.notifyDirtyFile = options && options.notifyDirtyFile || ((path) => {});

        this.handleInput = options && options.handleInput || false;
        this.requestInput = false;
        this.inputPrompt = null;

        this.requestedModuleNames = [];
        this.loadedModuleNames = [];
        this.failedModuleNames = [];
        this.fs = FileSystem.create();
        this.dirtyFiles = [];
    }

    load(then) {
        self.languagePluginUrl = "pyodide-build-0.14.1/";
        languagePluginLoader.then(() => {

            self.pyodideGlobal = {
                requestModule: (name) => this.requestModule(name),
                fs: this.fs,
                markFileDirty: (path) => this.markFileDirty(path)
            };

            pyodide.runPython(`
                import sys
                from js import pyodideGlobal
                class __ImportIntercept:
                    def find_spec(self, name, path, module):
                        pyodideGlobal.requestModule(name)
                sys.meta_path.append(__ImportIntercept())

                import io
                import js

                class MyTextFile(io.StringIO):
                    def __init__(self, filename, mode="r"):
                        self.filename = filename
                        self.readOnly = mode == "r"
                        content = js.pyodideGlobal.fs.getFile(filename)
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
                            js.pyodideGlobal.fs.setFile(self.filename, content)
                            pyodideGlobal.markFileDirty(self.filename)
                            super().close()

                global open
                def open(filename, mode="r", encoding=None):
                    return MyTextFile(filename, mode)

                import os

                def __os_listdir(path="."):
                    return list(js.pyodideGlobal.fs.getDir())
                os.listdir = __os_listdir

                # user code execution
                global_variables = {}
                def execute_code(src):
                    try:
                        code = compile(src, "<stdin>", mode="single")
                    except SyntaxError:
                        code = compile(src, "<stdin>", mode="exec")
                    exec(code, global_variables)
            `);

            then && then();
        });
    }

    requestModule(name) {
        if (this.requestedModuleNames.indexOf(name) < 0 &&
            this.loadedModuleNames.indexOf(name) < 0 &&
            this.failedModuleNames.indexOf(name) < 0) {
            this.requestedModuleNames.push(name);
        }
    }

    markFileDirty(path) {
        if (this.dirtyFiles.indexOf(path) < 0) {
            this.dirtyFiles.push(path);
            this.notifyDirtyFile(path);
        }
    }

    getDirtyFilePaths() {
        return this.dirtyFiles;
    }

    run(src) {
        // (re)set stdin and stderr
        pyodide.runPython(`
            import io, sys
            sys.stdout = io.StringIO()
            sys.stderr = sys.stdout
        `);

        // disable MatPlotLib output (will get it with matplotlib.pyplot.savefig)
        if (this.loadedModuleNames.indexOf("matplotlib") >= 0) {
            pyodide.runPython(`
                import matplotlib
                matplotlib.use('Agg')
            `);
        }

        // define one of the global variables src (no input) or corout (input)
        if (this.handleInput) {
            // convert src to a coroutine
            let cosrc = src
                .replace(/input\(\s*\)/g, "yield (None, locals())")
                .replace(/input\(([^\)]*)\)/g, "yield ($1, locals())");
                    // should be made more robust
            let globalVarNames = Object.keys(pyodide.globals.global_variables);
            cosrc = [`src = None\ndef corout(${globalVarNames.join(",")}):`].concat(cosrc.split("\n")).join("\n\t") + "\n";
            pyodide.runPython(cosrc);
        } else {
            pyodide.globals.src = src;
        }

        // run src until all requested modules have been loaded (or failed)
        let errMsg = "";
        this.requestedModuleNames = [];
        try {
            self.pyodideGlobal.setFigureURL = (url) => this.setFigureURL(url);
            if (this.handleInput) {
                this.requestInput = false;
                try {
                    pyodide.runPython(`
                        co = corout(**global_variables)
                        next_prompt, new_global_variables = co.send(None)
                    `);
                    this.inputPrompt = pyodide.globals.next_prompt;
                    this.requestInput = true;
                } catch (e) {
                    if (!/StopIteration/.test(err.message)) {
                        throw e;
                    }
                }
            } else {
                pyodide.runPython("execute_code(src)");
            }

            if (this.loadedModuleNames.indexOf("matplotlib") >= 0) {
                pyodide.runPython(`
                    import matplotlib.pyplot, io, base64, js
                    if matplotlib.pyplot.get_fignums():
                        with io.BytesIO() as buf:
                            matplotlib.pyplot.savefig(buf, format="png")
                            buf.seek(0)
                            js.pyodideGlobal.setFigureURL("data:image/png;base64," +
                                base64.b64encode(buf.read()).decode("ascii"))
                `);
            }
        } catch (err) {
            if (/ModuleNotFoundError/.test(err.message) &&
                this.requestedModuleNames.length > 0) {
                const nextModuleName = this.requestedModuleNames.shift();
                pyodide.loadPackage(nextModuleName)
                    .then(() => {
                        this.loadedModuleNames.push(nextModuleName);
                        this.run(src);
                    })
                    .catch(() => {
                        this.failedModuleNames.push(nextModuleName);
                    });
                // skip output and ui changes performed upon end
                // since we're not finished yet
                return false;
            } else {
                errMsg = err.message;
            }
        }

        let stdout = pyodide.runPython("sys.stdout.getvalue()");
        this.write(stdout + errMsg);

        this.ready && this.ready();

        return true;
    }

    submitInput(str) {
        if (this.requestInput) {
            // (re)set stdin and stderr
            pyodide.runPython(`
                import io, sys
                sys.stdout = io.StringIO()
                sys.stderr = sys.stdout
            `);

            this.requestInput = false;
            let errMsg = "";
            try {
                pyodide.globals.input_string = str;
                pyodide.runPython(`
                    next_prompt, new_global_variables = co.send(input_string)
                `);
                this.inputPrompt = pyodide.globals.next_prompt;
                this.requestInput = true;
            } catch (err) {
                if (!/StopIteration/.test(err.message)) {
                    errMsg = err.message;
                }
            }

            let stdout = pyodide.runPython("sys.stdout.getvalue()");
            this.write(stdout + errMsg);

            this.ready && this.ready();
        }
    }

    clearFigure() {
        if (this.loadedModuleNames.indexOf("matplotlib") >= 0) {
            pyodide.runPython(`
                import matplotlib.pyplot
                matplotlib.pyplot.close()
            `);
            const transp1by1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
            this.setFigureURL(transp1by1);
        }
    }

    clear() {
        this.clearText();
        this.clearFigure();
    }
}
