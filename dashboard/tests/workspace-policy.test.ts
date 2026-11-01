import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { absPath } from '../lib/server/files';
const prior = process.env.ACC_FILE_ROOT;
afterEach(() => { if(prior === undefined) delete process.env.ACC_FILE_ROOT; else process.env.ACC_FILE_ROOT = prior; });
test('workspace paths allowed and credential and traversal paths refused', () => {
 process.env.ACC_FILE_ROOT = '/tmp';
 expect(absPath('/tmp/task/file.ts')).toBe('/tmp/task/file.ts');
 expect(() => absPath(path.join(os.homedir(), '.codex', 'auth.json'))).toThrow();
 expect(() => absPath('/tmp/task/.env.local')).toThrow();
 expect(() => absPath('/tmp/../etc/passwd')).toThrow();
});

import { appServerTurn } from '../lib/server/agents/codex-app';
test('Codex app server refuses permission bypass before spawning', () => {
 expect(() => appServerTurn({key:'test',bin:'false',cwd:'/tmp',text:'test',mode:'bypassPermissions'})).toThrow('sandbox bypass is disabled');
});
