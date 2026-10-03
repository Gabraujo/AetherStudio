# Aether Studio para Android (APK privado)

Este projeto cria um aplicativo Android em tela cheia que abre a loja Aether no domínio oficial. O APK pode ser instalado manualmente e compartilhado diretamente, sem publicar o aplicativo em uma loja. O acesso administrativo continua protegido pelo login existente no site.

## Gerar o APK no Android Studio

1. Instale o Android Studio no computador e, no primeiro início, aceite a instalação do Android SDK 35 e das ferramentas de compilação.
2. No Android Studio, abra esta pasta `android/` (não a pasta raiz do site).
3. Aguarde a sincronização do Gradle e instale o JDK 17 se o Android Studio solicitar.
4. Selecione **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
5. O APK de teste será salvo em `android/app/build/outputs/apk/debug/app-debug.apk`.
6. Envie esse arquivo somente às pessoas escolhidas. No Android, abra o APK e permita a instalação dessa fonte quando o sistema solicitar.

Para criar uma versão assinada própria, use **Build > Generate Signed Bundle / APK > APK**. Guarde o arquivo de chave e as senhas em local seguro: sem eles não será possível atualizar o aplicativo já instalado mantendo a mesma identidade.

## Comportamento

- O site abre dentro do aplicativo e mantém cookies/sessões do WebView.
- Links do próprio domínio permanecem no aplicativo. Links externos, incluindo a tela segura de pagamento do Mercado Pago, são encaminhados ao aplicativo compatível no celular.
- Não há credenciais de pagamento ou segredos incorporados no APK.
