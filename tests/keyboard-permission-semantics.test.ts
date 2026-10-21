/**
 * 按钮权限（`action.permission.type`）语义回归测试
 *
 * 背景：QQ 开放平台官方定义 `action.permission.type` 为
 *   **0 = 指定用户**（须配 `specify_user_ids`）
 *   **1 = 管理员**
 *   **2 = 所有人**
 *
 * 本仓库此前把该字段注释成「0=全体 1=管理员 2=按钮指定 3=身份组」，
 * 与官方定义**完全相反**。按错误注释理解的下游代码把 `type: 2` 当成
 * 「仅指定用户可见」，实际下发的是「所有人可见可点」——群聊里的审批
 * 卡片因此对全群可见（越权面由点击时的操作者鉴权兜底，见
 * `src/types.ts` 的 `KEYBOARD_PERMISSION_EVERYONE` 说明）。
 *
 * 本测试锁定：
 * - 权限常量的取值与官方定义一致
 * - 全部内置按钮（审批 / ask_user / secret-input）使用具名常量，
 *   不再出现裸数字 `type: 2`（裸数字是这次语义错配的温床）
 * - `specify_user_ids` 在当前实现中**未被使用**（发起者 openid 在按钮
 *   渲染阶段不可得），一旦将来改用 type=0，本测试会提示同步更新
 *
 * 运行方式：npx tsx tests/keyboard-permission-semantics.test.ts
 */

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  KEYBOARD_PERMISSION_ADMIN,
  KEYBOARD_PERMISSION_EVERYONE,
  KEYBOARD_PERMISSION_SPECIFIED_USERS,
} from '../src/types.js';
import { buildApprovalKeyboard } from '../src/features/approval-helpers.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.error(`✗ ${name}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 递归收集 src/ 下的所有 .ts 文件 */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, acc);
    else if (entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

async function main() {
  // ── 常量取值与官方定义一致 ─────────────────────────────────────────

  await test('权限常量取值符合官方定义（0=指定用户 1=管理员 2=所有人）', () => {
    assert.strictEqual(
      KEYBOARD_PERMISSION_SPECIFIED_USERS,
      0,
      '指定用户应为 0（官方定义），不是「全体」',
    );
    assert.strictEqual(KEYBOARD_PERMISSION_ADMIN, 1, '管理员应为 1');
    assert.strictEqual(KEYBOARD_PERMISSION_EVERYONE, 2, '所有人应为 2');
  });

  // ── 内置按钮使用具名常量 ───────────────────────────────────────────

  await test('src/ 全仓不再出现裸的 permission: { type: 2 }', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // 匹配 permission 后紧跟裸数字 type（不含具名常量）
      if (/permission:\s*\{\s*type:\s*[0-9]/.test(content)) {
        offenders.push(file.replace(`${process.cwd()}/`, ''));
      }
    }
    assert.strictEqual(
      offenders.length,
      0,
      `以下文件仍在用裸数字权限值（应改用具名常量，避免语义错配复发）：\n${offenders.join('\n')}`,
    );
  });

  await test('审批按钮使用 KEYBOARD_PERMISSION_EVERYONE（官方语义：所有人）', () => {
    const keyboard = buildApprovalKeyboard('ap_test_1', 'exec', ['allow-once', 'deny']);
    assert.ok(keyboard, '应产出 keyboard');
    const buttons = keyboard.content.rows.flatMap((row) => row.buttons);
    assert.ok(buttons.length > 0, '应有按钮');
    for (const btn of buttons) {
      assert.strictEqual(
        btn.action.permission.type,
        KEYBOARD_PERMISSION_EVERYONE,
        '审批按钮的 permission 应为「所有人」（=2）',
      );
    }
  });

  // ── specify_user_ids 当前未被使用 ─────────────────────────────────

  await test('specify_user_ids 当前未被使用（发起者 openid 在渲染阶段不可得）', () => {
    const files = collectSourceFiles(join(process.cwd(), 'src'));
    const users: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // 排除类型定义（src/types.ts 里的接口声明）
      if (file.endsWith('types.ts')) continue;
      if (content.includes('specify_user_ids')) users.push(file.replace(`${process.cwd()}/`, ''));
    }
    assert.strictEqual(
      users.length,
      0,
      `若已开始下发 specify_user_ids，需同步更新本测试与 src/types.ts 的说明：\n${users.join('\n')}`,
    );
  });

  await test('src/types.ts 的权限注释与官方定义一致（不再写反）', () => {
    const content = readFileSync(join(process.cwd(), 'src', 'types.ts'), 'utf8');
    // 当前生效的注释行（KeyboardPermission 接口内的单行注释）
    assert.ok(
      /0=指定用户\s+1=管理员\s+2=所有人/.test(content),
      '类型注释应写明「0=指定用户 1=管理员 2=所有人」',
    );
    // 旧注释不得再出现在**生效注释位**上。
    // 说明段落里可以引用旧写法（保留历史信息），但不能再有第二处
    // 把它当作当前定义来描述。
    const effectiveCommentLines = content
      .split('\n')
      .filter((line) => line.trim().startsWith('*') && line.includes('='))
      .filter((line) => /0=全体|1=管理员\s+2=按钮指定|3=身份组/.test(line));
    assert.strictEqual(
      effectiveCommentLines.length,
      0,
      `不应再有把旧（写反的）语义当作当前定义的注释行：\n${effectiveCommentLines.join('\n')}`,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\n失败用例：\n${failedTests.map((t) => `  - ${t}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
