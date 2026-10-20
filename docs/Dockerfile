# 文档站的独立镜像：node 构建 VitePress 产物 → nginx 托管纯静态站点。
#
# 与应用的 Dockerfile 无关，也不共享上下文：应用镜像刻意把 docs/ 排除在外
# （根 .dockerignore 有 `docs`），文档站单独发布、单独访问。
#
# 构建上下文是 docs/ 本身（自包含：screenshots 与 theme 组件引用的图片都在 docs/ 下）：
#   docker build -f docs/Dockerfile -t aerolink-docs:local docs/
# 走仓库根做上下文会被 .dockerignore 的 `docs` 排除掉，所以别那样用。
#
# 两个基镜像都取自公司 SWR，与主 Dockerfile 的约定一致；直连环境可覆盖：
#   docker build -f docs/Dockerfile --build-arg NODE_IMAGE=node:24-alpine \
#     --build-arg NGINX_IMAGE=nginx:alpine \
#     --build-arg NPM_REGISTRY=https://registry.npmjs.org -t aerolink-docs:local docs/
ARG NODE_IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/node:24-alpine

# 运行基座 nginx（静态站只用到官方镜像的默认站点目录，版本不敏感）。
# SWR 上的路径是多级名拍平后的写法（`docker.io/library/nginx` 带进仓库路径），与 BreezeKube
# 推 calico-node 等镜像同一个手法。
ARG NGINX_IMAGE=swr.cn-south-1.myhuaweicloud.com/gzwxh/docker.io/library/nginx:1.31.7

FROM ${NODE_IMAGE} AS builder

WORKDIR /docs

# 唯一需要联网的环节。内网指向内部 npm 源即可（Makefile 的 docs-image 默认用 npmmirror）。
ARG NPM_REGISTRY=https://registry.npmjs.org

COPY package.json pnpm-lock.yaml ./

# pnpm 从 v10 起拒绝在「依赖构建脚本没有记录决策」时安装。仓库里的 docs/pnpm-workspace.yaml
# 是 pnpm 留下的占位文本（`esbuild: set this to true or false`），所以这里覆盖成明确决策：
# esbuild 自带预编译二进制，不需要跑它的安装脚本。
# 必须在 `COPY . .` **之后**写：否则会被上下文里那份占位文件盖掉，pnpm 随即以
# ERR_PNPM_IGNORED_BUILDS 拒绝安装（该错误也会让后面 pnpm exec 的隐式校验安装一起失败）。
RUN npm config set registry "${NPM_REGISTRY}" && npm install -g pnpm

COPY . .

RUN printf 'allowBuilds:\n  esbuild: false\n' > pnpm-workspace.yaml && \
    pnpm install --frozen-lockfile

# 不调用 `pnpm run docs:build`：那条脚本是 `git fetch --unshallow || vitepress build .`，
# 只有在 fetch 失败时才会真正构建，在容器里行为不可控。
#
# 也不能开着 lastUpdated：它会对每个页面 spawn git（node:24-alpine 里没有 git，也没有 .git
# 历史），实测直接以 `[vitepress] spawn git ENOENT` 中断构建。给构建阶段装 git 也不行——
# node:24-alpine 装 git 要连 alpine CDN（内网不可达，实测挂死），所以改成用环境变量关掉
# 「最后更新」显示（见 .vitepress/config.mts）。
ENV DOCS_SKIP_LAST_UPDATED=1
RUN pnpm exec vitepress build .

FROM ${NGINX_IMAGE}

# VitePress 默认 cleanUrls=false，产物是 <path>.html 的静态文件，链接自带后缀，
# 不需要 SPA 回退；直接覆盖默认站点目录即可。
COPY --from=builder /docs/.vitepress/dist /usr/share/nginx/html

# 从 docs/public/ 原样 COPY 过来的静态文件（logo、字体、首页配图）权限跟着宿主机走，
# 可能是 0600/0700，而 nginx worker 以非 root 运行，读不到就 403（实测 logo.svg 与
# /assets/fonts/*.woff2 全中）；统一放开读权限，免得依赖检出时的 umask。
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 80

# nginx 官方镜像的入口脚本会按需改写配置并前台启动，保持默认 CMD 即可。