# Simple debugger for Pyodide
# Yves Piguet, EPFL, Jan 2020

"""
Mechanism: run until the n:th breakpoint is reached, incrementing n
and restarting from the beginning to simulate "continue"

Test:

def fact(n):
    print("fact", n)
    if n > 0:
        print(n, "is strictly positive")
        return n * fact(n - 1)
    else:
        print("n is 0")
        return 1

from dbg import Dbg
d = Dbg()
d.set_breakpoint(4)
d.run(fact, 10)

"""

import sys
import os
import traceback
import textwrap

class Dbg:

    class Suspended(Exception):
        pass

    def __init__(self, interactive=True):
        self.interactive = interactive
        self.frame = None

        # breakpoint line numbers
        self.breakpoints = set()
        # for past breakpoints, tuple with action
        # ("R", "c", "n", "s", or "r") and locals
        self.break_action = []

        self.last_command = ""

        self.stdout = sys.stdout
        self.stderr = sys.stderr
        self.null = open(os.devnull, "w")

    def enable_print(self, on):
        sys.stdout = self.stdout if on else self.null
        sys.stderr = self.stderr if on else self.null

    def clear_breakspoints(self):
        self.breakpoints = set()

    def set_breakpoint(self, lineno):
        self.breakpoints.add(lineno)

    def run(self, fun, *args, **kwargs):
        self.fun = fun
        self.args = args
        self.kwargs = kwargs
        self.returned_value = None
        self.break_action = []
        self.resume("R")
        if self.interactive:
            self.cli()

    def resume(self, cmd):
        self.break_action.append((cmd,))

        action_count = 0
        while action_count < len(self.break_action) and self.break_action[action_count][0] == "r":
            action_count += 1
        break_next = False
        frame_next = None
        
        def trace(frame, event, arg):
            nonlocal action_count, break_next, frame_next
            action = self.break_action[action_count - 1][0]
            if event is "line":
                if (action in ["R", "s"] or
                    action == "n" and (frame is frame_next or break_next) or
                    action == "r" and break_next or
                    frame.f_lineno in self.breakpoints):
                    if action_count >= len(self.break_action):
                        self.frame = frame
                        raise self.Suspended()
                    else:
                        action_count += 1
                        frame_next = self.frame
                        if action_count >= len(self.break_action):
                            self.enable_print(True)
            elif event is "return":
                break_next = break_next or action in ["n", "r"] and frame is frame_next
            return trace
        suspended = False
        self.enable_print(len(self.break_action) <= 1)
        sys.settrace(trace)
        try:
            self.returned_value = self.fun(*self.args, **self.kwargs)
        except self.Suspended:
            suspended = True
        finally:
            sys.settrace(None)
        if not suspended:
            self.frame = None

    def cli(self):
        while self.frame:
            cmd = input(f"{self.frame.f_code.co_name}:{self.frame.f_lineno} dbg> ").strip() or self.last_command
            if cmd in ["c", "continue"]:
                self.resume("c")
                self.last_command = cmd
            elif cmd in ["cl", "clear"]:
                self.clear_breakspoints()
                self.last_command = ""
            elif cmd in ["h", "help"]:
                print(textwrap.dedent("""
                    c(ontinue)  continue
                    cl(ear)     clear all breakpoints
                    h(elp)      help
                    q(quit)     quit
                    r(eturn)    continue until the current function returns
                    s(tep)      step
                    w(here)     display a stack trace
                    expr        evaluate expression, including local and global variables
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
                try:
                    exec(compile(cmd, "<stdin>", "single"),
                         self.frame.f_globals,
                         self.frame.f_locals)
                except Exception as e:
                    traceback.print_exception(etype=type(e),
                                              value=e,
                                              tb=e.__traceback__)
