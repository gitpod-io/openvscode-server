
# Azure Resource Group Name 
variable "resource_group_name" {
  description = "Resource Group Name"
  type        = string
  default     = "rg-default"
}

# Azure Resources Location
variable "resource_group_location" {
  description = "Region in which Azure Resources to be created"
  type        = string
  default     = "centralindia"
}

variable "name_prefix" {
  description = "Name Prefix"
  type        = string
  default     = "gitpod-vscode-server"
}
