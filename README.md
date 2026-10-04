# Aether Studio

Loja de action figures com contas individuais, sessões persistidas no PostgreSQL, pedidos vinculados ao cliente, painel de catálogo protegido e checkout hospedado pelo Mercado Pago.

## Requisitos

- Node.js 24 LTS
- Docker Desktop no desenvolvimento local, ou Docker Engine e Docker Compose em uma VPS Linux
- Um endereço de e-mail para a conta administradora
- Credenciais de aplicação do Mercado Pago para aceitar pagamentos

## Desenvolvimento local no Windows

1. Instale Node.js 24 ou superior e o [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/); abra o Docker Desktop e aguarde o mecanismo iniciar.
2. No PowerShell, na pasta do projeto, execute `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local.ps1`.
3. Na primeira execução, o script cria `.env` se necessário, gera segredos locais, pede uma senha de administrador de 20 a 72 letras e números, inicia o PostgreSQL e instala dependências se estiverem faltando.
4. Abra `http://localhost:5173`. Entre com `aetherstudio.figures@gmail.com` e a senha inicial que você digitou.
5. Depois de confirmar o acesso ao painel, remova `ADMIN_BOOTSTRAP_PASSWORD` do `.env`. Nas próximas execuções, o script reconhece a conta existente e não pede a senha novamente.

O script preserva os segredos já definidos no `.env`. Se o Docker não estiver instalado ou em execução, ele informa como corrigir e para antes de iniciar a loja.

O servidor da API roda na porta 3000; o Vite encaminha `/api` para ele. A sessão fica em uma tabela PostgreSQL e usa cookie `HttpOnly`, `SameSite=Lax` e `Secure` em produção. Senhas são armazenadas como hashes bcrypt. Os pedidos guardam uma cópia do nome e preço das figures para preservar o histórico.

### Simulação completa em Docker

Para experimentar a mesma imagem conteinerizada usada no deploy sem instalar Node.js ou npm no Windows, instale o [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) e aguarde o mecanismo ficar em execução. Na pasta do projeto, abra o PowerShell e rode:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-docker-local.ps1
```

Na primeira execução, o script prepara segredos em `.env`, solicita a senha inicial do administrador e constrói/inicia a loja e o PostgreSQL. Acesse `http://localhost:3000` e entre com `aetherstudio.figures@gmail.com`. Cadastre figures de teste, carregue fotos, crie uma conta de cliente e confira o catálogo, sessões, carrinho e pedidos. Essa simulação usa banco e imagens em volumes Docker persistentes; parar os containers não apaga esses dados.

Para parar os containers, rode `docker compose -f docker-compose.local.yml down`. Para iniciar novamente, execute o script outra vez. Evite `down -v`, que remove os volumes com seu banco e as imagens. A porta local `3000` fica acessível apenas pela própria máquina.

O pagamento real permanece desativado sem as credenciais do Mercado Pago. Webhooks de pagamento não conseguem acessar `localhost`; para testar o ciclo completo, use credenciais de teste e uma URL HTTPS pública temporária. Defina essa URL em `AETHER_PUBLIC_URL`, `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET` no `.env`, abra a loja pela mesma URL pública e cadastre `https://sua-url-temporaria/api/payments/webhook` nos webhooks de teste do Mercado Pago. Depois recrie o app com `docker compose -f docker-compose.local.yml up -d --build --force-recreate app`. Nunca use credenciais de produção durante a simulação.

## Conta administradora

O e-mail `aetherstudio.figures@gmail.com` é o único que recebe acesso de administração. A conta é criada pelo servidor com `ADMIN_BOOTSTRAP_PASSWORD`; não há cadastro público para esse e-mail. Depois do primeiro início bem-sucedido, apague `ADMIN_BOOTSTRAP_PASSWORD` do `.env` e entre pelo botão **Entrar**. O painel permite incluir, editar, publicar, arquivar/restaurar figures, informar preço, estoque, categoria e carregar imagens JPG, PNG ou WebP de até 5 MB. Também exibe os 200 pedidos mais recentes, com o status do pagamento, os dados do cliente e o endereço de entrega. As quatro peças usadas como referência visual são criadas como rascunhos sem estoque; revise preço, quantidade e foto antes de publicar. O arquivamento tira a figure da vitrine sem apagar referências dos pedidos.

Não envie `.env`, credenciais do Mercado Pago, senhas de administrador ou tokens ao GitHub. `.env` já está coberto pelo `.gitignore`.

## Pagamentos

O checkout usa os componentes seguros do Mercado Pago dentro da loja: o cliente pode gerar Pix com QR Code e código copia e cola ou preencher o cartão sem sair do site. Os campos do cartão são renderizados pelo Card Payment Brick do Mercado Pago e tokenizados no navegador; a Aether recebe somente o token e não armazena número nem CVV. O checkout não salva cartões para compras futuras.

- `MP_ACCESS_TOKEN`: Access Token da aplicação Mercado Pago. O token permanece exclusivamente no backend.
- `MP_PUBLIC_KEY`: Public Key da mesma aplicação e do mesmo ambiente (teste ou produção). Ela é usada pelo Brick no navegador e pode ser exposta ao cliente.
- `MP_WEBHOOK_SECRET`: chave secreta de Webhooks da aplicação.
- `APP_URL`: origem pública HTTPS da loja, por exemplo `https://seudominio.com.br`.

Cadastre os valores no serviço da loja no Coolify. No painel do Mercado Pago, abra as credenciais da aplicação AetherStudio e copie a Public Key e o Access Token do mesmo ambiente. Não confunda a Public Key com o Client Secret. Salve e faça redeploy no Coolify. Pix e cartão dependem das permissões e da habilitação desses meios na conta recebedora.

Configure a notificação **payment** no painel Mercado Pago para `https://seudominio.com.br/api/payments/webhook`. Durante o desenvolvimento, use credenciais de teste e uma URL pública de túnel para testar webhooks; troque para as credenciais de produção quando publicar.

No Compose do Coolify, `MP_EXPECT_LIVE` assume `true`; assim, o servidor ignora pagamentos de teste em produção. Para um ambiente separado de homologação com credenciais de teste, defina `MP_EXPECT_LIVE=false`. Nunca use essa opção na loja que recebe pedidos reais. Em produção, `SESSION_SECRET` deve ter pelo menos 64 bytes; `openssl rand -hex 48` gera um valor adequado. Pedidos reservam o estoque por 30 minutos e o QR Pix expira junto com a reserva.

### Homologação de pagamentos

Faça a primeira compra em uma implantação de homologação separada, com banco e credenciais de teste próprios; não troque a loja pública para `MP_EXPECT_LIVE=false`. Crie uma conta de vendedor e uma conta de comprador de teste no Mercado Pago, configure o webhook para a URL pública HTTPS de homologação e use o segredo correspondente à aplicação de teste. A documentação do Mercado Pago explica como criar [contas de teste](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/test-accounts) e configurar/simular [notificações de pagamento](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications). Para validar compras de teste, use a ferramenta **Simular** no painel de Webhooks quando aplicável; não presuma que cada pagamento de teste enviará automaticamente a mesma notificação que uma transação de produção.

## E-mails transacionais

Os e-mails automáticos incluem a logo oficial Aether como imagem embutida.

O servidor pode enviar recuperação de senha, confirmação de pedido, mudanças de pagamento e atualizações de envio usando a API do Resend. Configure `RESEND_API_KEY` e `EMAIL_FROM` no ambiente; use como remetente um endereço de um domínio verificado no Resend. Antes de enviar para clientes, publique os registros SPF e DKIM fornecidos pelo provedor e configure DMARC no DNS. Não use o endereço Gmail de administração como remetente do domínio.

As mensagens de pedido ficam numa fila persistida no PostgreSQL e são reenviadas automaticamente em caso de falha temporária. A recuperação de senha usa token aleatório de uso único, armazena somente seu hash e expira em 30 minutos. O link só aparece na tela de login quando o provedor está configurado. Se um e-mail ficar em estado final de falha, revise a configuração do remetente e os registros DNS no Resend antes de solicitar nova notificação.

`EMAIL_FROM` deve estar no formato `Aether Studio <pedidos@aetherstudio3d.com>`, ajustado para o endereço verificado. Não coloque `RESEND_API_KEY` no GitHub. Para trocar por SMTP ou outro provedor, substitua a camada `server/email.js`; as regras de recuperação e a fila de notificações ficam no backend.

## Deploy em VPS com Coolify

Esta opção usa o proxy HTTPS do Coolify. Use `docker-compose.coolify.yml`; ele publica a aplicação na rede interna do Docker e mantém PostgreSQL e imagens em volumes persistentes. Não use `docker-compose.yml` neste fluxo, pois esse arquivo inclui um Caddy próprio que ocupa as portas 80 e 443 do servidor.

1. Na HypeHost, contrate uma VPS Linux com acesso root e selecione Ubuntu 24.04. O plano KVM 6GB é uma opção inicial para esta loja; a página da HypeHost informa 6 GB de RAM e 60 GB SSD. Coolify requer pelo menos 2 núcleos de CPU, 2 GB de RAM e 10 GB de disco; deixe recursos disponíveis para o site e o PostgreSQL. Confira os requisitos atuais na [documentação do Coolify](https://coolify.io/docs/start-with-self-hosted) e as condições da [VPS Linux da HypeHost](https://hypehost.com.br/vps-linux).
2. Na Cloudflare, crie registros `A` para `@` e `www`, ambos apontando para o IPv4 da VPS. Para a primeira emissão do certificado, deixe-os como **DNS only** (nuvem cinza). Quando o site abrir em HTTPS, você poderá habilitar o proxy da Cloudflare e configurar SSL/TLS como **Full (strict)**.
3. Libere SSH (`22/tcp`) e tráfego web (`80/tcp`, `443/tcp`) no firewall do provedor. Para instalar, conecte-se como `root` por SSH, instale `curl` e siga o [instalador oficial do Coolify](https://coolify.io/docs/start-with-self-hosted), que exige acesso root. O comando automatizado documentado é `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`; execute-o apenas na VPS nova e confira a documentação antes. Para abrir o painel durante a configuração, prefira um túnel SSH (`ssh -L 8000:127.0.0.1:8000 -L 6001:127.0.0.1:6001 -L 6002:127.0.0.1:6002 root@IP_DA_VPS`) e acesse `http://localhost:8000` no seu navegador; assim as portas do painel não precisam ficar abertas ao público.
4. No Coolify, crie um projeto e uma aplicação a partir do repositório público `https://github.com/Gabraujo/AetherStudio`, branch `main`. Selecione **Docker Compose** e informe `docker-compose.coolify.yml` como arquivo Compose, na raiz do repositório.
5. Em **Environment Variables**, configure `APP_URL=https://seudominio.com.br`, `SESSION_SECRET`, `POSTGRES_PASSWORD` e `ADMIN_BOOTSTRAP_PASSWORD`. Defina `ADMIN_EMAIL=aetherstudio.figures@gmail.com`. Gere segredos fortes na VPS com `openssl rand -hex 48` para `SESSION_SECRET` e `openssl rand -hex 32` para as senhas. O Compose conecta ao serviço `db` usando host, usuário, senha e nome do banco em campos separados; não crie `DATABASE_URL` manualmente nem publique a porta do banco. Não coloque credenciais ou o `.env` no GitHub.
6. Em **Domains** do serviço `app`, informe `https://seudominio.com.br:3000` (e, se quiser, `https://www.seudominio.com.br:3000`). Não configure domínio para `db`. Faça o deploy e aguarde os serviços `db` e `app` ficarem saudáveis; então confira `https://seudominio.com.br/api/health`. Coolify encaminha o domínio para a porta 3000 e gerencia HTTPS pelo seu proxy. Veja [Docker Compose no Coolify](https://coolify.io/docs/applications/builds/docker-compose) e [domínios e HTTPS](https://coolify.io/docs/core/networking/domains).
7. Depois do primeiro acesso administrativo, remova `ADMIN_BOOTSTRAP_PASSWORD` das variáveis do Coolify e reinicie/reimplante a aplicação. Cadastre suas figures reais no painel. Os exemplos iniciais são rascunhos sem estoque.
8. Quando a URL HTTPS estiver ativa, configure o webhook **Pagamentos** no Mercado Pago para `https://seudominio.com.br/api/payments/webhook`, salve o segredo em `MP_WEBHOOK_SECRET` e informe o Access Token em `MP_ACCESS_TOKEN`. Teste com credenciais e conta compradora de teste antes de trocar para produção.

O acesso direto ao painel Coolify pela porta 8000 pode ser fechado depois que um domínio seguro para o painel estiver configurado. Consulte as [regras de firewall do Coolify](https://coolify.io/docs/core/infrastructure/servers/firewall). Para este fluxo, configure os agendamentos nativos do Coolify para o banco e para o volume `product_uploads`, com destino fora da VPS e restauração testada. O script `deploy/backup.sh` abaixo usa `docker compose exec` e serve para o deploy direto, não para o Compose gerenciado pelo Coolify.

## Produção em VPS com domínio (Docker Compose e Caddy)

1. Na HypeHost, escolha uma VPS Linux com acesso root, endereço IPv4 público e portas TCP 80/443 liberadas. O plano KVM 6GB é uma opção inicial adequada para esta loja e a página informa 6 GB de RAM e 60 GB SSD; selecione Ubuntu 24.04 no provisionamento e confira as condições vigentes na [página de VPS Linux da HypeHost](https://hypehost.com.br/vps-linux).
2. Registre um domínio se ainda não tiver um e aponte os registros DNS `A` do domínio principal e de `www` para o IPv4 da VPS. Só crie `AAAA` se for configurar o IPv6 informado pelo provedor.
3. Instale Docker Engine e o plugin Docker Compose na VPS usando o [guia oficial para Ubuntu](https://docs.docker.com/engine/install/ubuntu/). O acesso root da VPS Linux permite instalar Docker; a HypeHost lista Ubuntu 24.04 entre os sistemas disponíveis.
4. Faça commit e push da versão revisada para o GitHub antes de cloná-la na VPS; confira que o remoto inclui `Dockerfile`, `docker-compose.yml` e `server/`. Não envie `.env`, `node_modules`, `uploads` ou backups ao GitHub.
5. Clone a versão atualizada na VPS. Copie `.env.example` para `.env` e configure segredos próprios, `ADMIN_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `DOMAIN=seudominio.com.br`, `APP_URL=https://seudominio.com.br` e as credenciais Mercado Pago de produção.
6. Configure `POSTGRES_PASSWORD` com uma senha aleatória forte. O Compose passa essa senha diretamente ao PostgreSQL e à aplicação; não precisa copiar a senha para uma URL.
7. Execute `docker compose up -d --build`.
8. Confira `https://seudominio.com.br/api/health` e os logs com `docker compose logs -f app proxy`.
9. Depois de confirmar a primeira inicialização do administrador, remova `ADMIN_BOOTSTRAP_PASSWORD` do `.env` e recrie o serviço com `docker compose up -d --force-recreate app`.

Caddy encaminha HTTPS e solicita/renova certificados automaticamente quando o DNS já aponta para a VPS e as portas 80/443 estão abertas. O endereço `www` redireciona para o domínio principal. O PostgreSQL não fica exposto à internet. O volume `postgres_data` preserva os dados durante atualizações do container; ele **não substitui backups externos**. Faça backups criptografados e periódicos e teste a restauração antes de depender da loja em produção.

### Backups do banco e das imagens

No deploy direto com Docker Compose, execute `sh deploy/backup.sh` na pasta do projeto. O script cria dump do PostgreSQL e arquivo das imagens, calcula checksums, impede backups simultâneos e remove arquivos locais mais antigos que `BACKUP_RETENTION_DAYS` (30 dias por padrão). Para enviar uma cópia externa, configure previamente o `rclone` e defina `RCLONE_REMOTE`, por exemplo `s3:aether-backups/producao`. Para cifrar os arquivos antes de salvá-los ou enviá-los, instale `age` e defina `AGE_RECIPIENT` com a chave pública; guarde a chave privada fora da VPS. Exemplo de execução:

```sh
BACKUP_DIR=/var/backups/aether \
BACKUP_RETENTION_DAYS=30 \
AGE_RECIPIENT='age1...' \
RCLONE_REMOTE='s3:aether-backups/producao' \
sh deploy/backup.sh
```

Agende a execução diária no cron do host e direcione a saída para um log protegido. Configure o rclone e as credenciais no usuário de sistema que executará o cron; use um caminho remoto dedicado a esta loja. O script exige `AGE_RECIPIENT` sempre que `RCLONE_REMOTE` estiver definido, para não enviar dados de clientes sem cifra. Sem `AGE_RECIPIENT`, os arquivos locais não são cifrados. Após configurar, verifique a cópia remota e teste a restauração em uma instância separada. Para deploy direto ou Coolify, mantenha o roteiro em [`deploy/PRODUCTION_CHECKLIST.md`](deploy/PRODUCTION_CHECKLIST.md).

Exemplo de entrada no `crontab -e` do usuário que administra o Compose (ajuste os caminhos e valores):

```cron
0 3 * * * cd /opt/aether && BACKUP_DIR=/var/backups/aether BACKUP_RETENTION_DAYS=30 AGE_RECIPIENT='age1...' RCLONE_REMOTE='s3:aether-backups/producao' /bin/sh deploy/backup.sh >> /var/log/aether-backup.log 2>&1
```

## Verificação e operação

- Build: `npm.cmd run build`
- API: `GET /api/health`
- Produtos públicos: `GET /api/products`
- Pedidos do cliente: `GET /api/orders` (sessão autenticada)
- Administração: `/api/admin/*` (somente a conta configurada)

O estado de pedido `paid_after_expiry` indica uma aprovação tardia após a reserva de estoque expirar; revise esse caso antes de separar o produto. Os pedidos também exibem separadamente o status financeiro recebido do Mercado Pago. Não envie pedidos com pagamento em contestação, chargeback, reembolso ou status desconhecido sem revisar a transação diretamente no painel do provedor. Reembolsos não repõem estoque automaticamente, pois é necessário confirmar a devolução física do item.
