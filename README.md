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

## Conta administradora

O e-mail `aetherstudio.figures@gmail.com` é o único que recebe acesso de administração. A conta é criada pelo servidor com `ADMIN_BOOTSTRAP_PASSWORD`; não há cadastro público para esse e-mail. Depois do primeiro início bem-sucedido, apague `ADMIN_BOOTSTRAP_PASSWORD` do `.env` e entre pelo botão **Entrar**. O painel permite incluir, editar, publicar, arquivar/restaurar figures, informar preço, estoque, categoria e carregar imagens JPG, PNG ou WebP de até 5 MB. Também exibe os 200 pedidos mais recentes, com o status do pagamento, os dados do cliente e o endereço de entrega. As quatro peças usadas como referência visual são criadas como rascunhos sem estoque; revise preço, quantidade e foto antes de publicar. O arquivamento tira a figure da vitrine sem apagar referências dos pedidos.

Não envie `.env`, credenciais do Mercado Pago, senhas de administrador ou tokens ao GitHub. `.env` já está coberto pelo `.gitignore`.

## Pagamentos

O checkout usa Mercado Pago Checkout Pro, com pagamento processado fora do site pela página segura do provedor. Cadastre no ambiente do servidor:

- `MP_ACCESS_TOKEN`: Access Token da aplicação Mercado Pago. O token permanece exclusivamente no backend.
- `MP_WEBHOOK_SECRET`: chave secreta de Webhooks da aplicação.
- `APP_URL`: URL pública completa da loja, por exemplo `https://seudominio.com.br`.

Enquanto esses valores não estiverem definidos, o checkout informa que está indisponível e não cria pedidos falsos. O cliente é redirecionado ao ambiente do Mercado Pago. A loja só marca o pedido pago depois de validar a assinatura do webhook e consultar o pagamento no próprio Mercado Pago. Pedidos reservam o estoque por 30 minutos; uma rotina devolve o estoque quando a reserva expira.

Configure a notificação **payment** no painel Mercado Pago para `https://seudominio.com.br/api/payments/webhook`. Durante o desenvolvimento, use credenciais de teste e uma URL pública de túnel para testar webhooks; troque para as credenciais de produção quando publicar.

## Produção em VPS com domínio

1. Na HypeHost, escolha uma VPS Linux com acesso root, endereço IPv4 público e portas TCP 80/443 liberadas. O plano KVM 6GB listado atualmente tem 2 vCPUs, 6 GB de RAM e 60 GB SSD, acima do mínimo deste projeto; selecione Ubuntu 24.04 no provisionamento. Confira as condições e o preço vigentes na [página de VPS Linux da HypeHost](https://hypehost.com.br/vps-linux).
2. Registre um domínio se ainda não tiver um e aponte os registros DNS `A` do domínio principal e de `www` para o IPv4 da VPS. Só crie `AAAA` se for configurar o IPv6 informado pelo provedor.
3. Instale Docker Engine e o plugin Docker Compose na VPS usando o [guia oficial para Ubuntu](https://docs.docker.com/engine/install/ubuntu/). O acesso root da VPS Linux permite instalar Docker; a HypeHost lista Ubuntu 24.04 entre os sistemas disponíveis.
4. Faça commit e push da versão revisada para o GitHub antes de cloná-la na VPS; confira que o remoto inclui `Dockerfile`, `docker-compose.yml` e `server/`. Não envie `.env`, `node_modules`, `uploads` ou backups ao GitHub.
5. Clone a versão atualizada na VPS. Copie `.env.example` para `.env` e configure segredos próprios, `ADMIN_EMAIL`, `ADMIN_BOOTSTRAP_PASSWORD`, `DOMAIN=seudominio.com.br`, `APP_URL=https://seudominio.com.br` e as credenciais Mercado Pago de produção.
6. Configure `POSTGRES_PASSWORD` e a senha dentro de `DATABASE_URL` com o mesmo valor. Use uma senha gerada, sem caracteres especiais não codificados na URL.
7. Execute `docker compose up -d --build`.
8. Confira `https://seudominio.com.br/api/health` e os logs com `docker compose logs -f app proxy`.
9. Depois de confirmar a primeira inicialização do administrador, remova `ADMIN_BOOTSTRAP_PASSWORD` do `.env` e recrie o serviço com `docker compose up -d --force-recreate app`.

Caddy encaminha HTTPS e solicita/renova certificados automaticamente quando o DNS já aponta para a VPS e as portas 80/443 estão abertas. O endereço `www` redireciona para o domínio principal. O PostgreSQL não fica exposto à internet. O volume `postgres_data` preserva os dados durante atualizações do container; ele **não substitui backups externos**. Faça backups criptografados e periódicos e teste a restauração antes de depender da loja em produção.

### Backups do banco e das imagens

Na VPS, dentro da pasta do projeto, execute `sh deploy/backup.sh`. O script cria um dump PostgreSQL e um arquivo separado com as imagens enviadas, em `./backups`, com permissões restritas. Esses arquivos contêm dados pessoais de clientes: criptografe-os antes de copiá-los para armazenamento externo e mantenha cópias fora da VPS. Programe a execução periódica e teste a restauração em um ambiente separado.

## Verificação e operação

- Build: `npm.cmd run build`
- API: `GET /api/health`
- Produtos públicos: `GET /api/products`
- Pedidos do cliente: `GET /api/orders` (sessão autenticada)
- Administração: `/api/admin/*` (somente a conta configurada)

O estado de pedido `paid_after_expiry` indica uma aprovação tardia após a reserva de estoque expirar; revise esse caso antes de separar o produto.
