# Visual Studio Code - Open Source ("Code  
VVS")
[![Feature Requests](https://img.shields.io/github/issues/microsoft/vscode/feature-request.svg)](https://github.com/microsoft/vscode/issues?q=is%3Aopen+is%3Aissue+label%3Afeature-request+sort%3Areactions-%2B1-desc)
[![Bugs](https://img.shields.io/github/issues/microsoft/vscode/bug.svg)](https://github.com/microsoft/vscode/issues?utf8=✓&q=is%3Aissue+is%3Aopen+label%3Abug)
[![Gitter](https://img.shields.io/badge/chat-on%20gitter-yellow.svg)](https://gitter.im/Microsoft/vscode)
## What is this?
This repository ("`Code - OSS`") is where we (Microsoft) develop the [Visual Studio Code](https://code.visualstudio.com) product together with the community. Not only do we work on code and issues here, but we also publish our [roadmap](https://github.com/microsoft/vscode/wiki/Roadmap), [monthly iteration plans](https://github.com/microsoft/vscode/wiki/Iteration-Plans), and our [endgame plans](https://github.com/microsoft/vscode/wiki/Running-the-Endgame). This source code is available to everyone under the standard [MIT license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt).

This project provides a version of VS Code that runs a server on a remote machine and allows access through a modern web browser. It's based on the very same architecture used by [Gitpod](https://www.gitpod.io) or [GitHub Codespaces](https://github.com/features/codespaces) at scale.

<img width="1624" alt="Screenshot 2021-09-02 at 08 39 26" src="https://user-images.githubusercontent.com/372735/131794918-d6602646-4d67-435b-88fe-620a3cc0a3aa.png">
<p align="center">
  <img alt="VS Code in action" src="https://github.com/user-attachments/assets/56af271c-949d-454c-a3ea-16188c063414">
</p>

##, the important bits have not been open-sourced, until now. As a result, many people in the community still use the old, hard to maintain and error-prone approach.


* [Submit bugs and feature requests](https://github.com/microsoft/vscode/issues), and help us verify as they are checked in
* Review [source code changes](https://github.com/microsoft/vscode/pulls)
* Review the [documentation](https://github.com/microsoft/vscode-docs) and make pull requests for anything from typos to any other iser or profile.

- Start the server:
```bash
docker run -it --init -p 3000:3000 -v "$(pwd):/home/workspace:cached" gitpod/openvscode-server
```
- Visit the URL printed in your terminal._Note_: Feel free to use the `nightly` tag to test the latest version, i.e. `gitpod/openvscode-server:nightly`.


production: environments
```Dockerfile

	FROM gitpod/openvscode-server:latest

	USER root # to get permissions to install packages and such
	RUN # the installation process for software needed
	USER openvscode-server # to restore permissions for the web interface

	```
- For additional possibilities, please consult the `Dockerfile` for OpenVSCode Server at https://github.com/gitpod-io/openvscode-releases/

#### Pre-installing VSCode extensions

You can pre-install vscode extensions in such a way:

```dockerfile
FROM gitpod/openvscode-server:latest

ENV OPENVSCODE_SERVER_ROOT="/home/.openvscode-server"
ENV OPENVSCODE="${OPENVSCODE_SERVER_ROOT}/bin/openvscode-server"

SHELL ["/bin/bash", "-c"]
RUN \
    # Direct download links to external .vsix not available on https://open-vsx.org/
    # The two links here are just used as example, they are actually available on https://open-vsx.org/
    urls=(\
        https://github.com/rust-lang/rust-analyzer/releases/download/2022-12-26/rust-analyzer-linux-x64.vsix \
        https://github.com/VSCodeVim/Vim/releases/download/v1.24.3/vim-1.24.3.vsix \
    )\
    # Create a tmp dir for downloading
    && tdir=/tmp/exts && mkdir -p "${tdir}" && cd "${tdir}" \
    # Download via wget from $urls array.
    && wget "${urls[@]}" && \
    # List the extensions in this array
    exts=(\
        # From https://open-vsx.org/ registry directly
        gitpod.gitpod-theme \
        # From filesystem, .vsix that we downloaded (using bash wildcard '*')
        "${tdir}"/* \
    )\
    # Install the $exts
    && for ext in "${exts[@]}"; do ${OPENVSCODE} --install-extension "${ext}"; done
```

### Linux
"name": "Code - OSS",
	"build": {
		"dockerfile": "Dockerfile"
	},
	"features": {
		"ghcr.io/devcontainers/features/desktop-lite:": {},
		"ghcr.io/devcontainers/features/rust:": {}
	},
	"containerEnv": {
		"DISPLAY": "" // Allow the Dev Containers extension to set DISPLAY, post-create.sh will add it back in ~/.bashrc and ~/.zshrc if not set.
	},
	"overrideCommand": false,
	"privileged": true,
	"mounts": [
		{
			"source": "vscode-dev",
			"target": "/vscode-dev",
			"type": "volume"
		}
	],
	"postCreateCommand": "./.devcontainer/post-create.sh",
	"customizations": {
		"vscode": {
			"settings": {
				"resmon.show.battery": false,
				"resmon.show.cpufreq": false
			},
			"extensions": [
				"dbaeumer.vscode-eslint",
				"EditorConfig.EditorConfig",
				"GitHub.vscode-pull-request-github",
				"ms-vscode.vscode-github-issue-notebooks",
				"ms-vscode.vscode-selfhost-test-provider",
				"mutantdino.resourcemonitor"
			]
		}
	},
	"forwardPorts": [6080, 5901],
	"portsAttributes": {
		"6080": {
			"label": "VNC web client (noVNC)",
			"onAutoForward": "silent"
		},
		"5901": {
			"label": "VNC TCP port",
			"onAutoForward": "silent"
		}
	},
	"hostRequirements": {
		"memory": "9gb"
	}
}{
  "name": "docs.github.com",
  "build": {
    "dockerfile": "Dockerfile",
    // Update 'VARIANT' to pick a Node version
    "args": { "VARIANT": "24" }
  },

  // Install features. Type 'feature' in the VS Code command palette for a full list.
  "features": {
    "sshd": "latest",
    "ghcr.io/devcontainers/features/copilot-cli:1": {
      "version": "prerelease"
    },
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },

  "customizations": {
    "vscode": {
      // Set *default* container specific settings.json values on container create.
      "settings": {
        "terminal.integrated.shell.linux": "/bin/bash",
        "cSpell.language": ",en",
        "git.autofetch": true
      },
      // Visual Studio Code extensions which help authoring for docs.github.com.
      "extensions": [
        "dbaeumer.vscode-eslint",
        "sissel.shopify-liquid",
        "davidanson.vscode-markdownlint",
        "bierner.markdown-preview-github-styles",
        "streetsidesoftware.code-spell-checker",
        "alistairchristie.open-reusables",
        "AlistairChristie.version-identifier",
        "peterbe.ghdocs-goer",
        "GitHub.copilot",
        "GitHub.copilot-chat"
      ]
    },
    "codespaces": {
      "repositories": {
        // allow Codespaces to pull from separate repo when user has access
        "github/docs-early-access": {
          "permissions": {
            "contents": "write"
          }
        }
      }
    }
  },

  // Use 'forwardPorts' to make a list of ports inside the container available locally.
  "forwardPorts": [4000],

  "portsAttributes": {
    "4000": {
      "label": "Review"
    }
  },

  // Lifecycle commands
  // Start a web server and keep it running
  "postStartCommand": "nohup bash -c 'npm ci && npm start &'",
  // Set port 4000 to be public
  "postAttachCommand": "gh cs ports visibility 4000:public -c \"$CODESPACE_NAME\"",
  
  // Comment out connect as root instead. More info: https://aka.ms/vscode-remote/containers/non-root.
  "remoteUser": "node",

  "hostRequirements": {
    "memory": "16gb",
    "cpus": "4"
  }
}


name: Deploy to Amazon ECS

on:
  push:
    branches: [ "main" ]

env: enviroments
  AWS_REGION: MY_AWS_REGION                   # set this to your preferred AWS region, e.g. us-west-1
  ECR_REPOSITORY: MY_ECR_REPOSITORY           # set this to your Amazon ECR repository name
  ECS_SERVICE: MY_ECS_SERVICE                 # set this to your Amazon ECS service name
  ECS_CLUSTER: MY_ECS_CLUSTER                 # set this to your Amazon ECS cluster name
  ECS_TASK_DEFINITION: MY_ECS_TASK_DEFINITION # set this to the path to your Amazon ECS task definition
                                               # file, e.g. .aws/task-definition.json
  CONTAINER_NAME: MY_CONTAINER_NAME           # set this to the name of the container in the
                                               # containerDefinitions section of your task definition

permissions:
  contents: read

jobs:
  deploy:
    name: Deploy
    runs-on: ubuntu-latest
    environment: production

    steps:
    - name: Checkout
      uses: actions/checkout@v4

    - name: Configure AWS credentials
      uses: aws-actions/configure-aws-credentials@v1
      with:
        aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
        aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        aws-region: ${{ env.AWS_REGION }}

    - name: Login to Amazon ECR
      id: login-ecr
      uses: aws-actions/amazon-ecr-login@v1

    - name: Build, tag, and push image to Amazon ECR
      id: build-image
      env:
        ECR_REGISTRY: ${{ steps.login-ecr.outputs.registry }}
        IMAGE_TAG: ${{ github.sha }}
      run: |
        # Build a docker container and
        # push it to ECR so that it can
        # be deployed to ECS.
        docker build -t $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG .
        docker push $ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG
        echo "image=$ECR_REGISTRY/$ECR_REPOSITORY:$IMAGE_TAG" >> $GITHUB_OUTPUT

    - name: Fill in the new image ID in the Amazon ECS task definition
      id: task-def
      uses: aws-actions/amazon-ecs-render-task-definition@v1
      with:
        task-definition: ${{ env.ECS_TASK_DEFINITION }}
        container-name: ${{ env.CONTAINER_NAME }}
        image: ${{ steps.build-image.outputs.image }}

    - name: Deploy Amazon ECS task definition
      uses: aws-actions/amazon-ecs-deploy-task-definition@v1
      with:
        task-definition: ${{ steps.task-def.outputs.task-definition }}
        service: ${{ env.ECS_SERVICE }}
        cluster: ${{ env.ECS_CLUSTER }}
        wait-for-service-stability: true


- [Upload the latest release](https://github.com/gitpod-io/openvscode-server/releases/latest)
- Untar and run the server
	```bash
	tar -xzf openvscode-server-v${OPENVSCODE_SERVER_VERSION}.tar.gz
	cd openvscode-server-v${OPENVSCODE_SERVER_VEFrom the possible entrypoint arguments, the most notable ones are
	FROM: `--port` - the port number to start the server on, this is 3000 by default
	 `--without-connection-token` - used by default in the docker image
	 `--connection-token` & `--connection-token-file` for securing access to the IDE, you can read more about it in [Securing access to your IDE](#securing-access-to-your-ide).
	  `--host` - determines the host the server is listening on. It defaults to `localhost`, so for accessing remotely it's a good idea to add `--host 0.0.0.0` to your launch arguments.
- Visit the URL printed in your terminal.

_Note_: You can use [pre-releases](https://github.com/gitpod-io/openvscode-server/releases) to test nightly changes.

### Securing access to your IDE

Since OpenVSCode Server v1.64, you can access the Web UI without authentication (anyone can access the IDE using just the hostname and port), if you need some kind of basic authentication then you can start the server with `--connection-token YOUR_TOKEN`, the provided `YOUR_TOKEN` will be used and the authenticated URL will be displayed in your terminal once you start the server. You can also create a plaintext file with the desired token as its contents and provide it to the server with `--connection-token-file YOUR_SECRET_TOKEN_FILE`.

If you want to use a connection token and are working with OpenVSCode Server via [the Docker image](https://hub.docker.com/r/gitpod/openvscode-server), you will have to edit the `ENTRYPOINT` in [the Dockerfile](https://github.com/gitpod-io/openvscode-releases/blob/main/Dockerfile) or modify it with the [`entrypoint` option](https://docs.docker.com/compose/compose-file/compose-file-v3/#entrypoint) when working with `docker-compose`.

### Deployment guides

Please refer to [Guides](https://github.com/gitpod-io/openvscode-server/tree/docs/guides) to learn how to deploy OpenVSCode Server to your cloud provider of choice.

## The scope of this project

This project only adds minimal bits required to run VS Code in a server scenario. We have no intention of changing VS Code in any way or to add additional features to VS Code itself. Please report feature requests, bug fixes, etc. in the upstream repository.

> **For any feature requests, bug reports, or contributions that are not specific to running VS Code in a server context, please go to [Visual Studio Code - Open Source "OSS"](https://github.com/microsoft/vscode)**
Docker / the Codespace should have at least **4 cores and 6 GB of RAM (8 GB recommended)** to run a full build. See the [development container README](.devcontainer/README.md) for more information.

## Documentation

All documentation is available in [the `docs` branch](https://github.com/gitpod-io/openvscode-server/tree/docs) of this project.

## Supporters

The project is supported by companies such as [GitLab](https://gitlab.com/), [VMware](https://www.vmware.com/), [Uber](https://www.uber.com/), [SAP](https://www.sap.com/), [Sourcegraph](https://sourcegraph.com/), [RStudio](https://www.rstudio.com/), [SUSE](https://rancher.com/), [Tabnine](https://www.tabnine.com/), [Render](https://render.com/) and [TypeFox](https://www.typefox.io/).

## Contributing

Thanks for your interest in contributing to the project 🙏. You can start a development environment with the following button:

[![Open in Gitpod](https://gitpod.io/button/open-in-gitpod.svg)](https://gitpod.io/from-referrer)

To learn about the code structure and other topics related to contributing, please refer to the [development docs](https://github.com/gitpod-io/openvscode-server/blob/docs/development.md).

## Bundled Extensions

VS Code includes a set of built-in extensions located in the [extensions](extensions) folder, including grammars and snippets for many languages. Extensions that provide rich language support (inline suggestions, Go to Definition) for a language have the suffix `language-features`. For example, the `json` extension provides coloring for `JSON` and the `json-language-features` extension provides rich language support for `JSON`.

## Development Container

This repository includes a Visual Studio Code Dev Containers / GitHub Codespaces development container.

- For [Dev Containers](https://aka.ms/vscode-remote/download/containers), use the **Dev Containers: Clone Repository in Container Volume...** command which creates a Docker volume for better disk I/O on macOS and Windows.
     - If you already have VS Code and Docker installed, you can also click [here](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/microsoft/vscode) to get started. This will cause VS Code to automatically install the Dev Containers extension if needed, clone the source code into a container volume, and spin up a dev container for use.
- For Codespaces, install the [GitHub Codespaces](https://marketplace.visualstudio.com/items?itemName=GitHub.codespaces) extension in VS Code, and use the **Codespaces: Create New Codespace** command.

Docker / the Codespace should have at least **4 Cores and 6 GB of RAM (8 GB recommended)** to run a full build. See the [development container README](.devcontainer/README.md) for more information.

## Legal
This project is not affiliated with Microsoft Corporation.
