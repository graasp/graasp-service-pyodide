# Simple debugger for Pyodide
# Yves Piguet, EPFL, Jan-Feb 2020

"""
Mechanism: run until the n:th breakpoint is reached, incrementing n
and restarting from the beginning to simulate "continue"

Test:

def fact(n):
    print("fact", n)
    if n > 0:
        print(n, "is strictly positive")
        f1 = fact(n - 1)
        return n * f1
    else:
        print("n is 0")
        return 1

from dbg import debugcall
debugcall(fact, 10)

or

from dbg import debugcode
code = '''c = fact(8) // (fact(3) * fact(8 - 3))
print(c)
'''
debugcode(code, locals=locals(), breakpoints=[2])

"""

class Dbg:

    import sys
    import os
    import re

    class Suspended(Exception):
        pass

    class SuspendedForInput(Suspended):
        pass
    
    def __init__(self, interactive=True):
        self.interactive = interactive
        self.frame = None

        # breakpoint line numbers
        self.breakpoints = set()
        self.break_at_start = True
        # past actions or inputs from the user
        # ("c"=continue, "n"=next, "s"=step, "r"=return, etc.)
        # resume will execute them and suspend execution when they're exhausted
        self.debug_action_history = []
        # True to ignore trace calls until 2nd event="call"
        self.ignore_top_call = False
        # substitution for input global function
        self.input_debug = None

        self.last_command = ""

        self.init_output()
        self.null = open(self.os.devnull, "w")

    def init_output(self):
        self.stdout = self.sys.stdout
        self.stderr = self.sys.stderr

    def enable_print(self, on):
        self.sys.stdout = self.stdout if on else self.null
        self.sys.stderr = self.stderr if on else self.null

    def clear_breakspoints(self):
        self.breakpoints = set()

    def set_breakpoint(self, lineno):
        self.breakpoints.add(lineno)

    def clear_breakspoint(self, lineno):
        self.breakpoints.remove(lineno)

    def is_suspended(self):
        return self.frame is not None

    def is_requesting_input(self):
        return self.request_input

    def debug_(self, fun, ignore_top_call, args, kwargs):
        self.fun = fun
        self.args = args
        self.kwargs = kwargs
        self.ignore_top_call = ignore_top_call
        self.returned_value = None
        self.debug_action_history = []
        self.resume(None)
        if self.interactive:
            self.cli()

    def debug_call(self, fun, *args, **kwargs):
        self.debug_(fun, False, args, kwargs)

    def debug_code(self, code, globals=globals(), locals=None):
        def input(prompt):
            return self.input_debug(prompt)
        globals["input"] = input
        self.debug_(lambda: exec(code, globals, locals), True, (), {})

    def resume(self, cmd):
        if cmd is not None:
            self.debug_action_history.append(cmd)

        # state ("s"=step, "n"=next, "r"=return, "c"=continue)
        state = "s" if self.break_at_start else "c"
        # index of first action in self.debug_action_history to perform
        action_count = 0
        # call depth used for "n" and "r"
        call_depth = 0
        last_break_depth = 0
        # number of event "call"
        call_count = 0

        def trace(frame, event, arg):
            nonlocal state, action_count, call_depth, last_break_depth, call_count
            if self.ignore_top_call:
                if event == "call":
                    if frame.f_code.co_name == "input":
                        if action_count >= len(self.debug_action_history):
                            # call to input(prompt): display prompt and request user input
                            if frame.f_locals["prompt"] is not None:
                                self.sys.stdout.write(frame.f_locals["prompt"])
                            self.frame = frame
                            raise self.SuspendedForInput()
                        else:
                            # execute input() defined below (picks input in self.debug_action_history)
                            pass
                    call_count += 1
                    call_depth += 1
                if call_count < 2:
                    return
            if event is "line":
                self.current_line = frame.f_lineno
                if (state == "n" and call_depth <= last_break_depth or
                    state == "r" and call_depth < last_break_depth or
                    state == "s" or
                    frame.f_lineno in self.breakpoints):
                    # breakpoint (explicit, or following s/n/r which should break here)
                    if action_count >= len(self.debug_action_history):
                        # not reached yet: really break here
                        self.frame = frame
                        raise self.Suspended()
                    else:
                        # already reached: continue
                        state = self.debug_action_history[action_count]
                        action_count += 1
                        last_break_depth = call_depth
                        if action_count >= len(self.debug_action_history):
                            self.enable_print(True)
                elif action_count >= len(self.debug_action_history):
                    self.enable_print(True)
            elif event is "call":
                call_depth += 1
            elif event is "return":
                call_depth -= 1
            return trace

        def input(prompt):
            nonlocal action_count
            str = self.debug_action_history[action_count]
            action_count += 1
            return str
        self.input_debug = input

        suspended = False
        self.request_input = False
        self.enable_print(len(self.debug_action_history) <= 1)
        self.sys.settrace(trace)
        try:
            self.returned_value = self.fun(*self.args, **self.kwargs)
        except self.SuspendedForInput:
            suspended = True
            self.request_input = True
        except self.Suspended:
            suspended = True
        finally:
            self.sys.settrace(None)
            self.enable_print(True)
        if not suspended:
            self.frame = None

    def eval_code(self, src):
        try:
            code = compile(src, "<stdin>", "single")
            exec(code,
                    self.frame.f_globals,
                    self.frame.f_locals)
        except Exception as e:
            import traceback
            traceback.print_exception(etype=type(e),
                                        value=e,
                                        tb=e.__traceback__)

    def exec_cmd(self, cmd):
        cmd = cmd.strip() or self.last_command
        r = self.re.compile(r"^(\S+)(\s+(\S+))$")
        match = r.match(cmd)
        if match:
            cmd0 = match.groups()[0]
            arg = match.groups()[2]
        else:
            cmd0 = cmd
            arg = None
        if cmd0 in ["b", "break"]:
            if arg is None:
                print(self.breakpoints)
            else:
                try:
                    lineno = int(arg)
                    self.set_breakpoint(lineno)
                except:
                    print("Bad line number")
            self.last_command = ""
        elif cmd in ["c", "continue"]:
            self.resume("c")
            self.last_command = cmd
        elif cmd0 in ["cl", "clear"]:
            if arg:
                try:
                    lineno = int(arg)
                    self.clear_breakspoint(lineno)
                except:
                    print("Bad line number")
            else:
                self.clear_breakspoints()
            self.last_command = ""
        elif cmd in ["h", "help"]:
            import textwrap
            print(textwrap.dedent("""
                b(reak) line  break at specified line
                c(ontinue)    continue
                cl(ear)       clear all breakpoints
                h(elp)        help
                q(quit)       quit
                r(eturn)      continue until the current function returns
                s(tep)        step
                w(here)       display a stack trace
                expr          evaluate expression, including local and global variables
                """))
            self.last_command = ""
        elif cmd in ["q", "quit"]:
            self.frame = None
        elif cmd in ["n", "next"]:
            self.resume("n")
            self.last_command = cmd
        elif cmd in ["r", "return"]:
            self.resume("r")
            self.last_command = cmd
        elif cmd in ["s", "step"]:
            self.resume("s")
            self.last_command = cmd
        elif cmd in ["w", "where"]:
            frame = self.frame
            while frame and (frame.f_code.co_name != "resume"):
                print(f"{frame.f_code.co_name} at line {frame.f_lineno}")
                frame = frame.f_back
        elif cmd != "":
            self.eval_code(cmd)

        # return true when execution is completed
        return self.frame is None

    def submit_input(self, input):
        self.debug_action_history.append(input)
        self.resume(None)

    def cli(self):
        while self.is_suspended():
            cmd = input(f"{self.frame.f_code.co_name}:{self.frame.f_lineno} dbg> ")
            self.exec_cmd(cmd)

def debugcall(fun, *args, **kwargs):
    dbg = Dbg()
    dbg.debug_call(fun, *args, **kwargs)

def debugcode(code, locals=None, breakpoints=None):
    dbg = Dbg()
    if breakpoints:
        for breakpoint in breakpoints:
            dbg.set_breakpoint(breakpoint)
    dbg.debug_code(code, locals=locals)
