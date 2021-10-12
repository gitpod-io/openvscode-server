# Terraform Block
terraform {
  required_version = ">= 1.0.0"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.0"
    }
  }
}

# Provider Block
provider "azurerm" {
  features {}
}

locals {
  webvm_custom_data = <<CUSTOM_DATA
#!/bin/sh
sudo apt-get update
wget https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v1.61.0/openvscode-server-v1.61.0-linux-x64.tar.gz
tar -xzf openvscode-server-v1.61.0-linux-x64.tar.gz 
cd openvscode-server-v1.61.0-linux-x64 
./server.sh
CUSTOM_DATA
}

# Resource-1: Azure Resource Group
resource "azurerm_resource_group" "rg" {
  name     = "gitpod-vscode-server"
  location = var.resource_group_location
  # tags     = local.common_tags
}

# Resource-2: Create Virtual Network
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.name_prefix}-virtual-network"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  # tags                = local.common_tags
}

# Resource-3: Create Subnet
resource "azurerm_subnet" "mysubnet" {
  name                 = "${var.name_prefix}-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.0.1.0/24"]
}

# Resource-4: Create Public IP Address
resource "azurerm_public_ip" "publicip" {
  name                = "${var.name_prefix}-vm-publicip"
  resource_group_name = azurerm_resource_group.rg.name
  location            = azurerm_resource_group.rg.location
  allocation_method   = "Static"
}

# Resource-5: Create Network Security Group (NSG) and rule
resource "azurerm_network_security_group" "nsg" {
  name                = "${var.name_prefix}-nsg"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

# Resource-6: Create NSG Rules
## Locals Block for Security Rules
locals {
  inbound_rules = {
    "100" : "80", # If the key starts with a number, you must use the colon syntax ":" instead of "="
    "110" : "443",
    "120" : "22",
    "130" : "3000",
  }
}
## NSG Inbound Rule for WebTier Subnets
resource "azurerm_network_security_rule" "inbound_rules" {
  for_each                    = local.inbound_rules
  name                        = "Rule-Port-${each.value}"
  priority                    = each.key
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Tcp"
  source_port_range           = "*"
  destination_port_range      = each.value
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = azurerm_resource_group.rg.name
  network_security_group_name = azurerm_network_security_group.nsg.name
}

# Resource-7: Create Network Interface (NIC)
resource "azurerm_network_interface" "nic" {
  name                = "${var.name_prefix}-nic"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "${var.name_prefix}-NIC-IP"
    subnet_id                     = azurerm_subnet.mysubnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.publicip.id
  }
}

# Connect the security group (NSG) to the network interface (NIC)
resource "azurerm_network_interface_security_group_association" "web_vmnic_nsg_associate" {
  network_interface_id      = azurerm_network_interface.nic.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

# Resource-8: Create (and display) an SSH key
resource "tls_private_key" "gitpod_vscode_ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}
output "tls_private_key" {
  value     = tls_private_key.gitpod_vscode_ssh.private_key_pem
  sensitive = true
}

# Resource: Azure Linux Virtual Machine
resource "azurerm_linux_virtual_machine" "web_linuxvm" {
  name                  = "${var.name_prefix}-vm"
  resource_group_name   = azurerm_resource_group.rg.name
  location              = azurerm_resource_group.rg.location
  size                  = "Standard_D2s_v3"
  admin_username        = "azureuser" #Change it if you want
  network_interface_ids = [azurerm_network_interface.nic.id]

  disable_password_authentication = true

  admin_ssh_key {
    username   = "azureuser"
    public_key = tls_private_key.gitpod_vscode_ssh.public_key_openssh
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "UbuntuServer"
    sku       = "18.04-LTS"
    version   = "latest"
  }
  #custom_data = filebase64("${path.module}/app-scripts/redhat-webvm-script.sh")
  custom_data = base64encode(local.webvm_custom_data)
}
