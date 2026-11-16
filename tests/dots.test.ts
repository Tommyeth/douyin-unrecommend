import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('Dots 私有状态：账号绑定、完整性、去重、取消复核、重叠任务和命令行持久化', () => {
  execFileSync('python3', ['tests/dots_state_test.py'], { stdio: 'pipe' });
});
