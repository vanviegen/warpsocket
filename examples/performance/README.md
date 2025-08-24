# Performance suite

This example spins up:
- A WarpSocket server with worker threads and a worker that:
  - subscribes each new connection into channels of 10 subscribers (per worker namespace)
  - on each request, broadcasts to the channel and then replies with an ack
  - prints statistics every 10s: subscribers and handled requests
- A client that opens N websocket connections (default 10k) and for each connection loops request->ack.

Run locally:

```sh
npm run build
node dist/examples/performance/server/server.js --bind 0.0.0.0:3000 --threads $(nproc)
# in another terminal
node dist/examples/performance/client/client.js --url ws://127.0.0.1:3000 --conns 10000
```

AWS Terraform (single server, multiple client machines):

```sh
cd examples/performance/infra/terraform
terraform init
terraform apply -var ssh_key_name=your-key-name -var ssh_public_key_path=~/.ssh/your-key.pub
```

After apply, Terraform will output the server_ip and client_ips.

Observability:
- Server statistics: SSH to the server (user ubuntu) and run `pm2 logs` to see `[perf-worker ...]` lines.
- CPU usage: on each instance, `htop` (install with `sudo apt-get install -y htop`) or `top`. With pm2: `pm2 monit`.
