terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
  required_version = ">= 1.6.0"
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "server_instance_type" { default = "c7i.8xlarge" }
variable "client_instance_type" { default = "c7i.4xlarge" }
variable "client_count"        { default = 4 }

resource "aws_vpc" "perf" {
  cidr_block           = "10.10.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "warpsocket-perf" }
}

resource "aws_subnet" "perf" {
  vpc_id                  = aws_vpc.perf.id
  cidr_block              = "10.10.1.0/24"
  map_public_ip_on_launch = true
  availability_zone       = data.aws_availability_zones.available.names[0]
}

resource "aws_internet_gateway" "gw" {
  vpc_id = aws_vpc.perf.id
}

resource "aws_route_table" "rt" {
  vpc_id = aws_vpc.perf.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.gw.id
  }
}

resource "aws_route_table_association" "rta" {
  subnet_id      = aws_subnet.perf.id
  route_table_id = aws_route_table.rt.id
}

data "aws_availability_zones" "available" {}

resource "aws_security_group" "perf" {
  name   = "warpsocket-perf-sg"
  vpc_id = aws_vpc.perf.id

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

variable "ssh_key_name" { type = string }

resource "aws_key_pair" "perf" {
  key_name   = var.ssh_key_name
  public_key = file(var.ssh_public_key_path)
}

variable "ssh_public_key_path" { type = string }

locals {
  user_data_common = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get update
    apt-get install -y nodejs git build-essential
    npm install -g pm2
  EOT
}

resource "aws_instance" "server" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.server_instance_type
  subnet_id              = aws_subnet.perf.id
  vpc_security_group_ids = [aws_security_group.perf.id]
  key_name               = aws_key_pair.perf.key_name
  user_data              = <<-EOT
    ${local.user_data_common}
    mkdir -p /opt/warpsocket-perf
    cd /opt/warpsocket-perf
    git clone https://github.com/vanviegen/warpsocket .
    npm ci
    npm run build
    pm2 start dist/examples/performance/server/server.js -- --bind 0.0.0.0:3000
  EOT
  tags = { Name = "warpsocket-perf-server" }
}

resource "aws_instance" "client" {
  count                  = var.client_count
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.client_instance_type
  subnet_id              = aws_subnet.perf.id
  vpc_security_group_ids = [aws_security_group.perf.id]
  key_name               = aws_key_pair.perf.key_name
  user_data              = <<-EOT
    ${local.user_data_common}
    mkdir -p /opt/warpsocket-perf
    cd /opt/warpsocket-perf
    git clone https://github.com/vanviegen/warpsocket .
    npm ci
    npm run build
    # Run one client process per core
    CORES=$(nproc)
    for i in $(seq 1 ${'$'}CORES); do
      pm2 start dist/examples/performance/client/client.js --name perf-client-${'$'}i -- --url ws://${aws_instance.server.public_ip}:3000 --conns 10000
    done
  EOT
  tags = { Name = "warpsocket-perf-client" }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

output "server_ip" { value = aws_instance.server.public_ip }
output "client_ips" { value = [for i in aws_instance.client : i.public_ip] }
