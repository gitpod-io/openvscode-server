FROM gitpod/openvscode-server-linux-build-agent:focal-x64 as code_builder

ENV TRIGGER_REBUILD 1

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
ENV VSCODE_ARCH=x64
ENV NPM_REGISTRY=https://registry.npmjs.org

ARG CODE_COMMIT
ARG CODE_QUALITY
ARG CODE_VERSION

RUN mkdir /gp-code
WORKDIR /gp-code

# Disable v8 cache used by yarn v1.x, refs https://github.com/nodejs/node/issues/51555
ENV DISABLE_V8_COMPILE_CACHE=1

# ENV npm_config_arch=x64
RUN mkdir -p .build

COPY ./vscode-web/ /vscode-web/
COPY .//vscode-reh-linux-x64/ /vscode-reh-linux-x64/

# config for first layer needed by blobserve
# this custom urls will be then replaced by blobserve.
# Check pkg/blobserve/blobserve.go, `inlineVars` method
RUN cp /vscode-web/out/vs/gitpod/browser/workbench/workbench.html /vscode-web/index.html \
&& cp /vscode-web/out/vs/gitpod/browser/workbench/callback.html /vscode-web/callback.html \
&& sed -i -e "s/{{VERSION}}/$CODE_QUALITY-$CODE_COMMIT/g" /vscode-web/index.html

# cli config: alises to gitpod-code
RUN cp /vscode-reh-linux-x64/bin/remote-cli/gitpod-code /vscode-reh-linux-x64/bin/remote-cli/code \
&& cp /vscode-reh-linux-x64/bin/remote-cli/gitpod-code /vscode-reh-linux-x64/bin/remote-cli/gp-code \
&& cp /vscode-reh-linux-x64/bin/remote-cli/gitpod-code /vscode-reh-linux-x64/bin/remote-cli/open

# grant write permissions for built-in extensions
RUN chmod -R ugo+w /vscode-reh-linux-x64/extensions

FROM scratch
# copy static web resources in first layer to serve from blobserve
COPY --from=code_builder --chown=33333:33333 /vscode-web/ /ide/
COPY --from=code_builder --chown=33333:33333 /vscode-reh-linux-x64/ /ide/

ARG CODE_VERSION
ARG CODE_COMMIT
LABEL "io.gitpod.ide.version"=$CODE_VERSION
LABEL "io.gitpod.ide.commit"=$CODE_COMMIT
