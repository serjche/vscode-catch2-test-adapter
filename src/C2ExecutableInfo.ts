//-----------------------------------------------------------------------------
// vscode-catch2-test-adapter was written by Mate Pek, and is placed in the
// public domain. The author hereby disclaims copyright to this source code.

import * as path from 'path';
import {inspect, promisify} from 'util';
import * as vscode from 'vscode';

import {C2AllTestSuiteInfo} from './C2AllTestSuiteInfo';
import {C2TestSuiteInfo} from './C2TestSuiteInfo';
import * as c2fs from './FsWrapper';
import {resolveVariables} from './Helpers';

export class C2ExecutableInfo implements vscode.Disposable {
  constructor(
      private _allTest: C2AllTestSuiteInfo, public readonly name: string,
      public readonly pattern: string, public readonly cwd: string,
      public readonly env: {[prop: string]: any}) {}

  private _disposables: vscode.Disposable[] = [];
  private _watcher: vscode.FileSystemWatcher|undefined = undefined;

  private readonly _executables: Map<string /*fsPath*/, C2TestSuiteInfo> =
      new Map();

  private readonly _lastEventArrivedAt:
      Map<string /*fsPath*/, number /*Date*/
          > = new Map();

  dispose() {
    if (this._watcher) this._watcher.dispose();
    while (this._disposables.length) this._disposables.pop()!.dispose();
  }

  async load(): Promise<void> {
    const wsUri = this._allTest.workspaceFolder.uri;
    const pattern =
        this.pattern.startsWith('./') ? this.pattern.substr(2) : this.pattern;
    const isAbsolute = path.isAbsolute(pattern);
    const absPattern = isAbsolute ? path.normalize(pattern) :
                                    path.resolve(wsUri.fsPath, pattern);
    const absPatternAsUri = vscode.Uri.file(absPattern);
    const relativeToWs = path.relative(wsUri.fsPath, absPatternAsUri.fsPath);
    const isPartOfWs = !relativeToWs.startsWith('..');

    if (isAbsolute && isPartOfWs)
      this._allTest.log.info(
          'Absolute path is used for workspace directory: ' + inspect([this]));
    if (this.pattern.indexOf('\\') != -1)
      this._allTest.log.warn(
          'Pattern contains backslash character: ' + this.pattern);

    let fileUris: vscode.Uri[] = [];

    if (!isAbsolute || isPartOfWs) {
      let relativePattern: vscode.RelativePattern;
      if (isAbsolute)
        relativePattern = new vscode.RelativePattern(
            this._allTest.workspaceFolder, relativeToWs);
      else
        relativePattern =
            new vscode.RelativePattern(this._allTest.workspaceFolder, pattern);
      try {
        fileUris =
            await vscode.workspace.findFiles(relativePattern, undefined, 1000);

        // abs path string or vscode.RelativePattern is required.
        this._watcher = vscode.workspace.createFileSystemWatcher(
            relativePattern, false, false, false);
        this._disposables.push(this._watcher);
        this._disposables.push(
            this._watcher.onDidCreate(this._handleCreate, this));
        this._disposables.push(
            this._watcher.onDidChange(this._handleChange, this));
        this._disposables.push(
            this._watcher.onDidDelete(this._handleDelete, this));
      } catch (e) {
        this._allTest.log.error(inspect([e, this]));
      }
    } else {
      fileUris.push(absPatternAsUri);
    }

    for (let i = 0; i < fileUris.length; i++) {
      const file = fileUris[i];
      if (await this._verifyIsCatch2TestExecutable(file.fsPath)) {
        const suite = this._addFile(file);
        this._executables.set(file.fsPath, suite);
      }
    }

    this._uniquifySuiteNames();

    for (const suite of this._executables.values()) {
      await suite.reloadChildren().catch((err: any) => {
        this._allTest.log.error(
            'Couldn\'t load suite: ' + inspect([err, suite]));
        // we could remove it, but now the user still sees the dead leaf
      });
    }
  }

  private _addFile(file: vscode.Uri) {
    const wsUri = this._allTest.workspaceFolder.uri;

    let resolvedName = this.name;
    let resolvedCwd = this.cwd;
    let resolvedEnv: {[prop: string]: string} = this.env;
    try {
      const relPath = path.relative(wsUri.fsPath, file.fsPath);

      const filename = path.basename(file.fsPath);
      const extFilename = path.extname(filename);
      const baseFilename = path.basename(filename, extFilename);
      const ext2Filename = path.extname(baseFilename);
      const base2Filename = path.basename(baseFilename, ext2Filename);
      const ext3Filename = path.extname(base2Filename);
      const base3Filename = path.basename(base2Filename, ext3Filename);

      const varToValue: [string, string][] = [
        ...this._allTest.variableToValue,
        ['${absPath}', file.fsPath],
        ['${relPath}', relPath],
        ['${absDirpath}', path.dirname(file.fsPath)],
        ['${relDirpath}', path.dirname(relPath)],
        ['${filename}', filename],
        ['${extFilename}', extFilename],
        ['${baseFilename}', baseFilename],
        ['${ext2Filename}', ext2Filename],
        ['${base2Filename}', base2Filename],
        ['${ext3Filename}', ext3Filename],
        ['${base3Filename}', base3Filename],
      ];
      resolvedName = resolveVariables(this.name, varToValue);
      if (resolvedName.match(/\$\{.*\}/))
        this._allTest.log.warn('Possibly unresolved variable: ' + resolvedName);
      resolvedCwd = path.normalize(resolveVariables(this.cwd, varToValue));
      if (resolvedCwd.match(/\$\{.*\}/))
        this._allTest.log.warn('Possibly unresolved variable: ' + resolvedCwd);
      resolvedEnv = resolveVariables(this.env, varToValue);
    } catch (e) {
      this._allTest.log.error(inspect([e, this]));
    }

    const suite = this._allTest.createChildSuite(
        resolvedName, file.fsPath, {cwd: resolvedCwd, env: resolvedEnv});

    return suite;
  }

  private _handleEverything(uri: vscode.Uri) {
    let suite = this._executables.get(uri.fsPath);

    if (suite == undefined) {
      suite = this._addFile(uri);
      this._executables.set(uri.fsPath, suite);
      this._uniquifySuiteNames();
    }

    const isRunning = this._lastEventArrivedAt.get(uri.fsPath) !== undefined;

    this._lastEventArrivedAt.set(uri.fsPath, Date.now());

    if (isRunning) return;

    const x =
        (exists: boolean, timeout: number, delay: number): Promise<void> => {
          let lastEventArrivedAt = this._lastEventArrivedAt.get(uri.fsPath);
          if (lastEventArrivedAt === undefined) {
            this._allTest.log.error('assert in ' + __filename);
            debugger;
            return Promise.resolve();
          }
          if (Date.now() - lastEventArrivedAt! > timeout) {
            this._lastEventArrivedAt.delete(uri.fsPath);
            this._executables.delete(uri.fsPath);
            this._allTest.testsEmitter.fire({type: 'started'});
            this._allTest.removeChild(suite!);
            this._allTest.testsEmitter.fire(
                {type: 'finished', suite: this._allTest});
            return Promise.resolve();
          } else if (exists) {
            return this._allTest.sendLoadEvents(() => {
              this._lastEventArrivedAt.delete(uri.fsPath);
              return suite!.reloadChildren().catch(() => {
                return x(false, timeout, Math.min(delay * 2, 2000));
              });
            });
          }
          return promisify(setTimeout)(Math.min(delay * 2, 2000)).then(() => {
            return c2fs.existsAsync(uri.fsPath).then((exists: boolean) => {
              return x(exists, timeout, Math.min(delay * 2, 2000));
            });
          });
        };
    // change event can arrive during debug session on osx (why?)
    x(false, this._allTest.execWatchTimeout, 64);
  }

  private _handleCreate(uri: vscode.Uri) {
    return this._handleEverything(uri);
  }

  private _handleChange(uri: vscode.Uri) {
    return this._handleEverything(uri);
  }

  private _handleDelete(uri: vscode.Uri) {
    return this._handleEverything(uri);
  }

  private _uniquifySuiteNames() {
    const uniqueNames: Map<string /* name */, C2TestSuiteInfo[]> = new Map();

    for (const suite of this._executables.values()) {
      const suites = uniqueNames.get(suite.origLabel);
      if (suites) {
        suites.push(suite);
      } else {
        uniqueNames.set(suite.origLabel, [suite]);
      }
    }

    for (const suites of uniqueNames.values()) {
      if (suites.length > 1) {
        let i = 1;
        for (const suite of suites) {
          suite.label = String(i++) + ') ' + suite.origLabel;
        }
      }
    }
  }

  private _verifyIsCatch2TestExecutable(path: string): Promise<boolean> {
    return c2fs.spawnAsync(path, ['--help'])
        .then(res => {
          return res.stdout.indexOf('Catch v2.') != -1;
        })
        .catch(e => {
          this._allTest.log.error(inspect(e));
          return false;
        });
  }
}