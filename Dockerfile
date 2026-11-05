# DSH（DeepSeek Harness）需要 Node.js；官方 npm 包 @deepseek-ai/dsh 已验证可在 Node 24 运行
# （官方以 Node 24.19.0 构建/验证）
#
# 关键点：@deepseek-ai/dsh 依赖的原生模块 node-pty（终端）在 npm 包里只带 macOS/Windows
# 的预编译产物（prebuilds/ 下仅有 darwin-arm64/darwin-x64/win32-arm64/win32-x64），
# Linux 上没有任何预编译二进制，安装时必然回退到 node-gyp 从源码编译，需要
# python3 + make + g++。node:24-slim 不含这些工具，直接 `npm install -g @deepseek-ai/dsh`
# 会报：
#   gyp ERR! find Python ... Could not find any Python installation to use
# 因此采用多阶段构建：先在带编译工具的阶段安装 DSH（顺带编译 node-pty），
# 再把 /usr/local（Node + DSH + 编译产物）复制进精简运行镜像，运行镜像不保留编译工具。

# ── 阶段 1：安装 DSH 并编译原生模块 ────────────────────────────────
# admin 变体预装最新 DSH（@next）到 /opt/dsh（即管理服务的安装目录，挂载空卷时自动填充、开箱即用）
FROM node:24-slim AS dsh-builder
ARG DEV_TOOLS=devtools
# DSH 版本：默认 next（跟随上游 next 通道，当前指向最新 rc）。
# CI 会按触发的上游 Release 传入精确版本，例如 --build-arg DSH_VERSION=0.2.2-rc.1，
# 保证镜像里的 DSH 版本与镜像 tag 严格一致；本地构建不传则维持原来的 @next 行为。
ARG DSH_VERSION=next
RUN : "${DSH_VERSION:=next}" \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && if [ "$DEV_TOOLS" = "admin" ]; then \
         npm install -g --prefix /opt/dsh --no-audit --no-fund @deepseek-ai/dsh@"$DSH_VERSION"; \
       else \
         npm install -g --no-audit --no-fund @deepseek-ai/dsh@"$DSH_VERSION"; \
       fi \
    && mkdir -p /opt/dsh

# ── 阶段 2：精简运行镜像 ───────────────────────────────────────────
FROM node:24-slim
WORKDIR /app

# 开发工具变体开关：<tag 前缀>（如 devtools / devtools-min）| none（不装）
# 本文件默认 devtools（完整工具版）；构建时通过 --build-arg DEV_TOOLS=<前缀> 覆盖，
# 各前缀要安装的工具由 .build-variants 文件按前缀定义，直接编辑该文件即可增删工具
ARG DEV_TOOLS=devtools

# 复制 Node 运行时 + DSH（含编译好的 node-pty）。两阶段同为 node:24-slim，
# /usr/local 内容一致，仅多出 npm 全局安装的 @deepseek-ai/dsh
COPY --from=dsh-builder /usr/local/ /usr/local/

# admin 变体：把构建阶段预装的最新 DSH 复制到管理服务安装目录 /opt/dsh
# （首次挂载空卷时 Docker 自动填充该目录，管理服务启动即识别并自动拉起 DSH）
COPY --from=dsh-builder /opt/dsh/ /opt/dsh/

# 生成版本文件，供 CI（docker-build/.github/workflows/projects.yml）用 docker cp 提取 APP_VERSION 打镜像标签；
# 若该文件缺失，CI 会回退为日期标签；admin 变体预装在 /opt/dsh，其余变体在 /usr/local
RUN if [ "$DEV_TOOLS" = "admin" ]; then \
      node -p "'APP_VERSION=' + require('/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json').version" > /tmp/app_version.env; \
    else \
      node -p "'APP_VERSION=' + require('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').version" > /tmp/app_version.env; \
    fi

# 代理代码及其依赖（http-proxy）
COPY proxy/ /app/proxy/
RUN cd /app/proxy && npm install --omit=dev --no-audit --no-fund

# 管理服务（admin 变体专用）：页面安装/切换 DSH 版本、配置 npm 源、托管 DSH 进程并反向代理
COPY manager/ /app/manager/
RUN cd /app/manager && npm install --omit=dev --no-audit --no-fund

# 启动脚本（默认流程：先启动 DSH，等待就绪后启动代理）
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh

# admin 变体标记：镜像内存在 /app/.admin-mode 时 entrypoint.sh 改走管理服务
# （预装最新 DSH，管理台仍可自选版本安装/切换、配置 npm 源）
RUN if [ "$DEV_TOOLS" = "admin" ]; then touch /app/.admin-mode; fi

# ── 开发工具（按 DEV_TOOLS 前缀从 .build-variants 读取工具列表安装）──
# .build-variants 每行：<tag前缀>|<apt 工具列表>|<npm 全局包列表（可空）>|<uv 安装标记（1=装/空=不装）>，DEV_TOOLS 取第一列前缀值
# 基础镜像（DEV_TOOLS=none）不装任何工具
COPY .build-variants /app/.build-variants
RUN if [ -n "$DEV_TOOLS" ] && [ "$DEV_TOOLS" != "none" ]; then \
      PACKAGES="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $2}' /app/.build-variants)"; \
      NPM_PKGS="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $3}' /app/.build-variants)"; \
      UV_FLAG="$(awk -F'|' -v p="$DEV_TOOLS" '$1==p {print $4}' /app/.build-variants)"; \
      if [ -n "$PACKAGES" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends $PACKAGES \
        && rm -rf /var/lib/apt/lists/*; \
      fi; \
      if [ -n "$NPM_PKGS" ]; then \
        npm install -g --no-audit --no-fund $NPM_PKGS; \
      fi; \
      if [ "$UV_FLAG" = "1" ]; then \
        curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh; \
      fi; \
    fi

# ── 特殊测试 tag（DEV_TOOLS=test）：DSH 安装完毕后额外安装插件 ────────
RUN if [ "$DEV_TOOLS" = "test" ]; then \
      dsh plugin --profile web add github:smanx/dsh-fixed-providers#master; \
    fi

# 对外端口：代理/管理服务默认均监听 3080（DSH 在容器内监听 127.0.0.1:<DSH_PORT>，不直接暴露）
EXPOSE 3080


#==========================
#==========================

RUN chmod 777 -R /app

COPY ./Dockerfile /

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3-pip \
    python3-venv \
    7zip \
    sudo \
 && rm -rf /var/lib/apt/lists/*

# 建立非 root 使用者
RUN id -u node >/dev/null 2>&1 || useradd -m -s /bin/bash node
RUN echo "node ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/node && chmod 0440 /etc/sudoers.d/node

RUN usermod -aG root node

USER node
WORKDIR /home/node

RUN mkdir -p /home/node/.dsh
RUN mkdir -p /home/node/workspace
RUN chown -R node:node /home/node

#==========================
#==========================
# 建立 SSH 目錄
RUN mkdir -p /home/node/.ssh \
 && touch /home/node/.ssh/known_hosts

# 預先加入 GitHub Host Key（避免互動式詢問）
RUN ssh-keyscan -T 5 github.com 2>/dev/null >> /home/node/.ssh/known_hosts || true

#开啟 ssh 设置
USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /var/run/sshd

#add user ssh
RUN echo 'node:deepseek' | chpasswd

#add root ssh
#RUN echo 'root:opencode' | chpasswd
#RUN sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config || echo 'PermitRootLogin yes' >> /etc/ssh/ssh>
#RUN sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config || echo 'PasswordAuthentication>

# SSH login fix. Otherwise user is kicked off after login
RUN sed 's@session\s*required\s*pam_loginuid.so@session optional pam_loginuid.so@g' -i /etc/pam.d/sshd

RUN echo "export VISIBLE=now" >> /etc/profile

# expose the port 22(which is the default port of ssh)
EXPOSE 22

USER node

#==========================
#==========================


ENTRYPOINT ["/app/entrypoint.sh"]

