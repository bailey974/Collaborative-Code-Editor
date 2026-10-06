import { describe, expect, it } from "vitest";
import { commandFor, listDir, parseCommand, splitArgs } from "./shell";

describe("splitArgs", () => {
  it("splits on whitespace", () => {
    expect(splitArgs("  python   main.py ")).toEqual(["python", "main.py"]);
  });
  it("keeps quoted arguments together", () => {
    expect(splitArgs(`cat "my file.py" 'other one.js'`)).toEqual(["cat", "my file.py", "other one.js"]);
  });
  it("returns nothing for a blank line", () => {
    expect(splitArgs("   ")).toEqual([]);
  });
});

describe("parseCommand", () => {
  it("ignores blank lines", () => {
    expect(parseCommand("")).toEqual({ kind: "none" });
  });

  it("runs Python files with python, python3 or py", () => {
    expect(parseCommand("python main.py")).toEqual({ kind: "run", path: "main.py" });
    expect(parseCommand("python3 src/app.py")).toEqual({ kind: "run", path: "src/app.py" });
    expect(parseCommand("py ./main.py")).toEqual({ kind: "run", path: "main.py" });
  });

  it("runs JavaScript files with node", () => {
    expect(parseCommand("node app.js")).toEqual({ kind: "run", path: "app.js" });
    expect(parseCommand("node lib/x.mjs")).toEqual({ kind: "run", path: "lib/x.mjs" });
  });

  it("runs any supported file with run", () => {
    expect(parseCommand("run index.html")).toEqual({ kind: "run", path: "index.html" });
    expect(parseCommand("run main.py")).toEqual({ kind: "run", path: "main.py" });
  });

  it("rejects the wrong file type for an interpreter", () => {
    expect(parseCommand("python app.js")).toEqual({ kind: "error", message: "python: app.js is not a .py file" });
    expect(parseCommand("node main.py")).toEqual({ kind: "error", message: "node: main.py is not a .js file" });
    expect(parseCommand("run notes.txt")).toEqual({
      kind: "error",
      message: "run: can't run notes.txt (supported: .py, .js, .mjs, .html)",
    });
  });

  it("asks for a file when none is given", () => {
    expect(parseCommand("python")).toEqual({ kind: "error", message: "usage: python <file>" });
    expect(parseCommand("cat")).toEqual({ kind: "error", message: "usage: cat <file>" });
  });

  it("parses ls, cat, clear and help", () => {
    expect(parseCommand("ls")).toEqual({ kind: "ls", path: "" });
    expect(parseCommand("ls src/")).toEqual({ kind: "ls", path: "src" });
    expect(parseCommand("cat src/a.py")).toEqual({ kind: "cat", path: "src/a.py" });
    expect(parseCommand("clear")).toEqual({ kind: "clear" });
    expect(parseCommand("help")).toEqual({ kind: "help" });
  });

  it("reports unknown commands", () => {
    expect(parseCommand("rm -rf /")).toEqual({
      kind: "error",
      message: "rm: command not found (type help for commands)",
    });
  });
});

describe("commandFor", () => {
  it("picks the command that runs a file", () => {
    expect(commandFor("main.py")).toBe("python main.py");
    expect(commandFor("src/app.js")).toBe("node src/app.js");
    expect(commandFor("index.html")).toBe("run index.html");
  });
  it("quotes paths with spaces", () => {
    expect(commandFor("my scripts/hello.py")).toBe(`python "my scripts/hello.py"`);
  });
});

describe("listDir", () => {
  const files = ["main.py", "src/app.js", "src/lib/util.js", "README.md"];
  const dirs = ["empty"];

  it("lists the root with folders marked by a slash", () => {
    expect(listDir(files, dirs, "")).toEqual(["empty/", "main.py", "README.md", "src/"]);
  });
  it("lists a folder", () => {
    expect(listDir(files, dirs, "src")).toEqual(["app.js", "lib/"]);
    expect(listDir(files, dirs, "empty")).toEqual([]);
  });
  it("lists a single file as itself", () => {
    expect(listDir(files, dirs, "src/app.js")).toEqual(["app.js"]);
  });
  it("returns null for a path that doesn't exist", () => {
    expect(listDir(files, dirs, "nope")).toBeNull();
  });
});
