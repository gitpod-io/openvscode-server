# Deploy OpenVSCode Server to Azure VM

## Prerequisites

To complete this guide, you need:
* an [Azure](https://azure.microsoft.com/en-us/) subscription

## Setup

### Create a VM

1. Navigate to https://portal.azure.com/#create/Microsoft.VirtualMachine-ARM
1. Launch a Ubuntu 20.04 instance with the default settings
  * **Caution**: Please follow security best practices when setting up your VM

### Download & extract OpenVSCode Server

**Caution**: Make sure you successfully connected to the VM before you execute the following commands.

First, let's define the release version we want to download. You can find the latest version on the [Releases](https://github.com/gitpod-io/openvscode-server/releases) page.

```bash
export SERVER_VERSION=1.60.0 # Replace with the latest version
```

With that in place, let's download & extract OpenVSCode server:

```bash
wget https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v$SERVER_VERSION/openvscode-server-v$SERVER_VERSION-linux-x64.tar.gz -O code-server.tar.gz
tar -xzf code-server.tar.gz
rm code-server.tar.gz
```
### Create an inbound rule for port 3000

To access OpenVSCode Server on port 3000 later, we have to create an inbound rule:
1. Open the instance dashboard
1. In the left menu pane, under Settings, select Networking.
1. In the bottom section, for the NSG rules for the network interface, select Add inbound port rule.
1. Populate the following fields (use default values for everything else):
 	* Destination port ranges: 3000
	* Protocol: TCP
1. Click "Add"


## Start the server

While you are still connected to the VM, execute the following commands to start OpenVSCode Server:

```bash
cd openvscode-server-v$SERVER_VERSION-linux-x64
./server.sh
```

## Access OpenVSCode Server

1. Navigate to the Overview pane for the VM
1. Copy the "Public IP address"
1. Visit the URL printed in your terminal. Just going to port 3000 won't work, because VS Code requires that you provide a uniquely generated security token to prevent unauthorized access.
1. Replace 'localhost' from the IP address on the terminal to your "Public IP address" in a new browser tab , i.e. ` http://localhost:3000/?tkn=f83f27f2-3e75-47a8-be84-6a8396d1491b` would become `http://52.251.44.195:3000/?tkn=f83f27f2-3e75-47a8-be84-6a8396d1491b`


## Teardown

1. Navigate to the Overview pane for the VM. You can find the VM under All Resources.
1. Click on "Stop"
