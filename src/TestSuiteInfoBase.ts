//-----------------------------------------------------------------------------
// vscode-catch2-test-adapter was written by Mate Pek, and is placed in the
// public domain. The author hereby disclaims copyright to this source code.

import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import * as path from 'path';
import { promisify, inspect } from 'util';
import { TestEvent, TestSuiteInfo } from 'vscode-test-adapter-api';

import { RootTestSuiteInfo } from './RootTestSuiteInfo';
import { TestInfoBase } from './TestInfoBase';
import * as c2fs from './FsWrapper';
import { generateUniqueId } from './IdGenerator';
import { TaskPool } from './TaskPool';

export abstract class TestSuiteInfoBase implements TestSuiteInfo {
  readonly type: 'suite' = 'suite';
  readonly id: string;
  label: string;
  children: TestInfoBase[] = [];
  file?: string;
  line?: number;

  private _isKill: boolean = false;
  private _proc: ChildProcess | undefined = undefined;

  constructor(
    public readonly origLabel: string,
    public readonly allTests: RootTestSuiteInfo,
    public readonly execPath: string,
    public readonly execOptions: SpawnOptions) {
    this.label = origLabel;
    this.id = generateUniqueId();
  }

  static determineTestTypeOfExecutable(execPath: string):
    Promise<{ type: 'catch2' | 'google' | undefined; version: [number, number, number]; }> {
    return c2fs.spawnAsync(execPath, ['--help'])
      .then((res): any => {
        const catch2 = res.stdout.match(/Catch v([0-9]+)\.([0-9]+)\.([0-9]+)\s?/);
        if (catch2 && catch2.length == 4) {
          return { type: 'catch2', version: [Number(catch2[1]), Number(catch2[2]), Number(catch2[3])] };
        }
        const google = res.stdout.match(/This program contains tests written using Google Test./);
        if (google) {
          return { type: 'google', version: [0, 0, 0] };
        }
        return { type: undefined, version: [0, 0, 0] };
      }).catch(() => { return { type: undefined, version: [0, 0, 0] }; });
  }

  abstract reloadChildren(): Promise<void>;

  protected abstract _getRunParams(childrenToRun: TestInfoBase[] | 'all'): string[];

  protected abstract _handleProcess(process: ChildProcess, childrenToRun: TestInfoBase[] | 'all'): Promise<void>;

  cancel(): void {
    this.allTests.log.info(
      'canceled: ' + inspect([this.id, this.label, this._proc != undefined]));

    this._isKill = true;

    if (this._proc != undefined) {
      this._proc.kill();
      this._proc = undefined;
    }
  }

  run(tests: Set<string>, taskPool: TaskPool): Promise<void> {
    this._isKill = false;
    this._proc = undefined;

    let childrenToRun: 'all' | TestInfoBase[] = 'all';

    if (tests.delete(this.id)) {
      for (let i = 0; i < this.children.length; i++) {
        const c = this.children[i];
        tests.delete(c.id);
      }
    } else {
      childrenToRun = [];

      for (let i = 0; i < this.children.length; i++) {
        const c = this.children[i];
        if (tests.delete(c.id)) childrenToRun.push(c);
      }

      if (childrenToRun.length == 0) return Promise.resolve();
    }

    return this._runInner(childrenToRun, taskPool);
  }

  private _runInner(childrenToRun: TestInfoBase[] | 'all', taskPool: TaskPool):
    Promise<void> {
    if (this._isKill) return Promise.reject(Error('Test was killed.'));

    if (!taskPool.acquire()) {
      return new Promise<void>(resolve => setTimeout(resolve, 64)).then(() => {
        return this._runInner(childrenToRun, taskPool);
      });
    }

    this.allTests.testStatesEmitter.fire(
      { type: 'suite', suite: this, state: 'running' });

    if (childrenToRun === 'all') {
      for (let i = 0; i < this.children.length; i++) {
        const c = this.children[i];
        if (c.skipped) {
          this.allTests.testStatesEmitter.fire(c.getStartEvent());
          this.allTests.testStatesEmitter.fire(c.getSkippedEvent());
        }
      }
    }

    const execParams = this._getRunParams(childrenToRun);

    this._proc = spawn(this.execPath, execParams, this.execOptions);
    let process: ChildProcess | undefined = this._proc;

    this.allTests.log.info('proc started: ' + inspect([this.execPath, execParams]));

    const startTime = Date.now();
    const killIfTimout = (): Promise<void> => {
      if (process === undefined) { return Promise.resolve(); }
      else if (this.allTests.execRunningTimeout !== null
        && Date.now() - startTime > this.allTests.execRunningTimeout) {
        process.kill();
        return Promise.resolve();
      } else {
        return promisify(setTimeout)(1000).then(killIfTimout);
      }
    };
    promisify(setTimeout)(1000).then(killIfTimout);

    return this._handleProcess(process, childrenToRun)
      .catch((reason: any) => {
        this.allTests.log.error(inspect(reason));
      })
      .then(() => {
        this.allTests.log.info('proc finished: ' + inspect(this.execPath));
        this.allTests.testStatesEmitter.fire({ type: 'suite', suite: this, state: 'completed' });

        taskPool.release();
        this._proc = undefined;
        process = undefined;
      });
  }

  protected _sendTestStateEventsWithParent(events: TestEvent[]) {
    this.allTests.sendTestSuiteStateEventsWithParent([
      { type: 'suite', suite: this, state: 'running' },
      ...events,
      { type: 'suite', suite: this, state: 'completed' },
    ]);
  }

  protected _findFilePath(matchedPath: string): string {
    let filePath = matchedPath;
    try {
      filePath = path.join(this.allTests.workspaceFolder.uri.fsPath, matchedPath);
      if (!c2fs.existsSync(filePath) && this.execOptions.cwd) {
        filePath = path.join(this.execOptions.cwd, matchedPath);
      }
      if (!c2fs.existsSync(filePath)) {
        let parent = path.dirname(this.execPath);
        filePath = path.join(parent, matchedPath);
        let parentParent = path.dirname(parent);
        while (!c2fs.existsSync(filePath) && parent != parentParent) {
          parent = parentParent;
          filePath = path.join(parent, matchedPath);
          parentParent = path.dirname(parent);
        }
      }
      if (!c2fs.existsSync(filePath)) {
        filePath = matchedPath;
      }
    } catch (e) {
      filePath = path.resolve(this.allTests.workspaceFolder.uri.fsPath, matchedPath);
    }
    return filePath;
  }
}