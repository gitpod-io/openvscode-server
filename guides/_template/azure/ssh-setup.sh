#!/bin/sh
# get ssh file
terraform output -raw tls_private_key > gitpod_ssh_file
chmod 600 gitpod_ssh_file
mv gitpod_ssh_file ~/.ssh