# 进度 JINDU

自己部署、自己保存数据的个人任务、学习、日历与招聘管理工具。适合一个人使用，在手机和电脑上访问同一份数据。

[安装](docs/DEPLOYMENT.md) · [使用说明](docs/USER_GUIDE.md) · [升级与恢复](docs/UPGRADING.md) · [参与开发](CONTRIBUTING.md) · [版本记录](CHANGELOG.md)

## 能做什么

- **任务与学习**：管理截止日期、重复任务、学习记录和进度。
- **日历**：通过对话新增、改期、查询和撤销安排；手机或 Outlook 可订阅日历。
- **招聘公告**：增量采集公开就业网页，按日期、地区、单位性质和行业筛选。
- **岗位核对**：结合个人条件检查公告和附件岗位表，保留原文依据、工作表与行号，导出 Excel；报名节点可加入日历。
- **AI 设置**：连接自行选择的 OpenAI 兼容接口，设置每日请求次数限制，查看 Token 用量。

任务、学习和手动日历不需要 AI。启用 AI 后，相关对话、个人条件及公告内容会发送到你配置的服务商；请求费用由该服务商收取。采集功能需要访问对应公开网站。

## 快速开始

需要 Linux、Docker Engine 和 Docker Compose v2。以下命令用于**全新安装**：

```sh
git clone https://github.com/deyuetian/jindu.git
cd jindu
git checkout v0.15.0
cp .env.example .env
# 编辑 .env：本机试用可保留默认值；公网部署先填写 HTTPS 网址。
docker compose build web
docker compose run --rm --no-deps init
docker compose up -d web worker
```

本机打开 `http://localhost:8788`，在 `private/login.txt` 中查看随机生成的初始账号和密码。密码不会输出到构建或初始化日志。远程服务器需先配置 HTTPS 反向代理，详见[部署说明](docs/DEPLOYMENT.md)。

默认仅监听 `127.0.0.1:8788`，不会直接向公网开放应用端口。一个镜像运行网页和单实例后台，SQLite 与附件保存在本机磁盘；无需 Redis 或独立数据库服务。

## 数据放在哪里，以后怎么更新

| 内容 | 位置 | 更新时的处理 |
|---|---|---|
| 应用代码与依赖 | 源码、构建出的镜像 | 换成新版本 |
| 数据库、附件、业务备份 | `data/` | 原样保留 |
| 账号校验值、加密主密钥、运行配置 | `private/config.json` | 原样保留 |
| 初始登录信息 | `private/login.txt` | 私密保管 |

**服务器安装就是公开应用加上自己的数据和配置。** 公共仓库不包含个人数据、账号或 API 密钥，也不需要维护另一套私人应用代码。部署参数通过配置文件和挂载目录传入。

已有安装使用[统一更新工具](docs/UPGRADING.md)：先生成固定更新计划，再停写、完整备份、校验恢复副本，最后切换程序并检查健康状态。数据版本不兼容时会拒绝启动；失败回退不以旧数据库覆盖新记录。已有安装不要重新执行初始化，也不要直接对旧 Compose 执行更新。升级成功后的当前部署位置记录在 `updates/active.json`。

## 当前边界

- 面向单用户、自行部署；不提供注册、多租户或团队权限管理。
- 正式部署以 Linux Docker、本地磁盘和单实例后台为范围。升级工具另需宿主机 Python 3.10 或以上，不支持命名数据卷、外部网络和额外服务依赖的自动升级。
- 附件支持常见 Excel、PDF、DOC、DOCX、文本及 ZIP。扫描 PDF、损坏文件、未识别表头或超限附件会保留待核对，不能保证完整识别。
- 岗位结论依据填写的个人条件和可读取原文；专业目录内置映射有限，缺少依据时保留待核对。结果不能代替招录单位认定。
- 需要登录或有特殊动态接口的就业网站可能需要单独适配。日历订阅的刷新时间由客户端决定。

## 开发与验证

使用 Node.js 22.22.2 和 Python 3.11；Python 建议使用独立虚拟环境。

```sh
npm ci
python -m pip install -r backend/requirements.txt
npm run typecheck
npm test
npm run build
npm run test:workbooks
npm run test:upgrade
JINDU_PYTHON=python npm run test:smoke
```

测试使用合成数据，不需要 AI 密钥。升级单元测试使用 Docker 模拟器；真实容器构建和运行由 CI 另行检查。项目结构与开发注意事项见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 反馈与许可

普通问题和功能建议请提交 [Issue](https://github.com/deyuetian/jindu/issues)。安全问题请遵循 [SECURITY.md](SECURITY.md)，不要公开密钥、登录配置、数据库、订阅地址或带个人资料的截图。

采用 [MIT 许可证](LICENSE)，版权署名为 deyuetian。依赖保留各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
