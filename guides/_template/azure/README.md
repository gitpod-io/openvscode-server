# Deploy OpenVSCode Server to Azure Virual Machine

## Prerequisites

1. Terraform
   Install azure cli on your OS. <br>
   [Terraform Offical Docs](https://learn.hashicorp.com/tutorials/terraform/install-cli)

2. Azure CLI <br>
   [Microsoft Azure Docs](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)

## Setup

### Login to Azure CLI

`az login` <br>
[Guide](https://docs.microsoft.com/en-us/cli/azure/get-started-with-azure-cli)

## Start the server

1. Open azure into any text editor, click on `variables.tf` file. Chnage the defaul location to your nearest azure data-center location.
2. Open command line in that folder and run following commands.

```
terraform init
terraform plan -out main.tfplan
terraform apply "main.tfplan"
```

3. Voila! Virtual machine is created
4. Now if you are using linux/mac operating system then follow below steps if you are using windows then go to step
   Open command prompt in terraform folder and type below commands

```
chmod +x ssh-setup.sh
./ssh-setup.sh
```

5. Install Git. Open terraform folder in Git bash terminal. Follow step 4.

## Access OpenVSCode Server

Go to Azure console and click on your virtual machine and copy public ip

#### or

Run this command
`az vm show -d -g gitpod-vscode-server -n gitpod-vscode-server-vm --query publicIps -o tsv`
<br> <br>

Paste public ip in browser with :3000 at the end <br>
Example - 199.199.199.199:3000

## Teardown

Open the same azure folder in the command line and type `terraform destroy` and then type yes. <br>
It will delete every resources.
