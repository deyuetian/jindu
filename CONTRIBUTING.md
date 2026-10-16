# 参与开发

欢迎通过 Issue 描述问题，或通过 Pull Request 提交修复。较大的功能或架构调整先说明使用场景、数据影响和验证方法，便于讨论范围。

## 环境与检查

使用 Node.js 22.22.2、npm 和 Python 3.11。Python 依赖建议安装在虚拟环境中；不要把开发测试指向正式数据或个人配置。

```sh
npm ci
python -m venv .venv
. .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm run typecheck
npm test
npm run build
npm run test:workbooks
npm run test:upgrade
JINDU_PYTHON=python npm run test:smoke
```

Windows 可用 PowerShell 执行对应命令，激活 `.venv\Scripts\Activate.ps1`，并用 `$env:JINDU_PYTHON='python'` 指定 Python。测试中调用 Python 的部分也支持 `JINDU_TEST_PYTHON` 指定解释器。服务器升级工具运行在 Linux；其 Python 测试中的 Docker 模拟器不能替代真实容器验收。

`npm run dev` 只启动前端开发服务，将 `/api` 转发到 `127.0.0.1:8788`。完整使用仍需要自行初始化的测试后端；正式安装请按部署文档使用 Docker。`npm start` 和 `npm run worker` 读取 `JINDU_CONFIG` 指定的配置，不提供默认账号或默认密钥。

## 代码位置

| 目录 | 用途 |
|---|---|
| `src/` | React 界面 |
| `backend/` | HTTP 服务、SQLite、后台任务、AI 与附件解析 |
| `shared/` | 共用模型、专业与资格核对、显示规则 |
| `server/security.ts` | 浏览器来源和安全响应处理 |
| `deploy/portable/` | 初始化、健康检查、合成运行检查、升级工具 |
| `tests/` | 行为测试与合成样例 |

## 提交要求

- 描述触发问题的操作、修复后的行为和实际执行的检查。使用简短提交标题，例如 `fix(calendar): preserve edited dates`。
- 新增测试应验证用户行为或故障边界；沿用现有 Vitest 和 Python 测试方式。
- 不提交 `data/`、`private/`、`.env`、数据库、真实附件、访问令牌或个人截图。复现问题使用合成样例。
- 数据结构变更必须更新 `backend/version.ts`、迁移逻辑和镜像兼容标签，验证迁移失败、旧数据保留与恢复路径。不能默认旧版本能读取新数据。
- 保持单实例后台约束。涉及任务重试、外部 AI 请求或采集时，检查重复执行、请求上限和中断恢复。
- 修改依赖时同步锁文件与第三方声明；修改部署行为时同步安装和升级文档。

提交前查看完整 diff，确认没有无关修改。CI 检查源码、工作簿处理、升级模拟及从公开 Dockerfile 构建的运行环境。安全问题请使用 [SECURITY.md](SECURITY.md) 中的渠道。
