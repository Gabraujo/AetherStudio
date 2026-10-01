# Checklist antes de abrir a loja

## Conta e segurança

- [ ] Definir senhas fortes e únicas para administrador, PostgreSQL, Coolify e SSH.
- [ ] Criar a conta administrativa com `ADMIN_BOOTSTRAP_PASSWORD`; depois da primeira entrada, remover essa variável do ambiente e redeployar.
- [ ] Confirmar que `.env`, tokens, chaves privadas e backups não estão no GitHub.
- [ ] No firewall da VPS, deixar públicos somente SSH (idealmente restrito ao seu IP), HTTP e HTTPS. Não publicar PostgreSQL nem o painel Coolify.
- [ ] Configurar Cloudflare com HTTPS válido e SSL/TLS em Full (strict) antes de ativar o proxy laranja.
- [ ] Atualizar Ubuntu, Docker e Coolify antes do lançamento e manter uma rotina de atualização.

## Dados e recuperação

- [ ] Configurar backup diário do PostgreSQL e do volume de imagens.
- [ ] Manter cópia externa à VPS e cifrada. Para o script `deploy/backup.sh`, configure `AGE_RECIPIENT` com uma chave pública age e `RCLONE_REMOTE` com um caminho dedicado já configurado no rclone. Guarde a chave privada age fora da VPS.
- [ ] Definir retenção adequada e confirmar que a execução envia todos os arquivos e checksums ao destino remoto.
- [ ] Restaurar um backup recente em um ambiente separado; confirmar usuários, pedidos, catálogo e imagens antes de depender do processo.
- [ ] Monitorar espaço de disco, uso de memória, health checks e falhas de deploy.

## Loja e pagamentos

- [ ] Revisar título, descrições, preços, estoque, fotos e seleção das figures em destaque.
- [ ] Fazer um pedido de teste como cliente e conferir conta, endereço, estoque, histórico e painel administrativo.
- [ ] Configurar o webhook do Mercado Pago na URL HTTPS pública e validar assinatura e atualização do pedido com credenciais de teste.
- [ ] Testar pagamento aprovado, recusado/cancelado e aprovado após a reserva expirar; conferir a reposição do estoque em cada caso.
- [ ] Só depois dos testes, trocar pelas credenciais de produção e confirmar que o Pix está habilitado na conta recebedora.
- [ ] Definir e publicar canais de atendimento, políticas de entrega, cancelamento e devolução antes de divulgar a loja.

## E-mail e atendimento

- [ ] Escolher um provedor de e-mail transacional e configurar SPF, DKIM e DMARC no DNS.
- [ ] Implementar e testar e-mails de confirmação de pedido e recuperação de senha antes de depender deles com clientes reais.
- [ ] Confirmar que os formulários de cadastro e newsletter informam claramente para que o e-mail será usado.

## Publicação

- [ ] Fazer primeiro um deploy privado/de teste com o domínio e HTTPS finais.
- [ ] Verificar `https://SEU_DOMINIO/api/health`, logs do app e do banco, imagens após redeploy e login de cliente/admin.
- [ ] Fazer um deploy de atualização e confirmar que os volumes persistem e que é possível voltar para a versão anterior.
- [ ] Abrir a divulgação somente depois de concluir a compra de teste e a restauração de backup.

## Backups no Coolify

Para o Compose gerenciado pelo Coolify, prefira os agendamentos nativos de backup do banco e do armazenamento persistente. Configure destino externo, retenção e teste de restauração no painel. O script `deploy/backup.sh` usa `docker compose exec` e é destinado ao deploy direto com Docker Compose na VPS; não o agende dentro do container da aplicação Coolify.
