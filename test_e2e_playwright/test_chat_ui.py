import subprocess
import time
import sys
import os
import pathlib
from playwright.sync_api import sync_playwright

PROJECT_DIR = str(pathlib.Path(__file__).resolve().parent.parent)
TEST_DB_URL = "postgresql://postgres:quaratest@localhost:5432/quara_test"

subprocess.run(
    [
        "psql",
        TEST_DB_URL,
        "-c",
        "TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides, gg_projetos RESTART IDENTITY",
    ],
    check=True,
    capture_output=True,
)

env = os.environ.copy()
env["PORT"] = "3461"
env["DATABASE_URL"] = TEST_DB_URL
# Deliberadamente SEM GEMINI_API_KEY — testa o comportamento real do estado "chat não configurado",
# que é exatamente como o app se comporta até a chave real ser colocada no Render.
server_proc = subprocess.Popen(
    ["node", "server.js"],
    cwd=PROJECT_DIR,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)

BASE_URL = "http://localhost:3461"
results = []


def check(desc, cond):
    status = "OK" if cond else "FAIL"
    print(f"{status}: {desc}")
    results.append(cond)


try:
    time.sleep(2.5)
    if server_proc.poll() is not None:
        print("SERVIDOR JÁ MORREU! Código de saída:", server_proc.returncode)
        print("Output do servidor:", server_proc.stdout.read())
        sys.exit(1)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        page.goto(BASE_URL)
        page.wait_for_timeout(800)

        # ---- Botão flutuante e abrir/fechar painel ----
        check("Botão flutuante de chat existe na tela", page.locator("#chat-toggle-btn").count() > 0)
        check("Painel de chat começa fechado", "chat-open" not in (page.locator("#chat-panel").get_attribute("class") or ""))

        page.click("#chat-toggle-btn")
        page.wait_for_timeout(300)
        check("Painel abre ao clicar no botão flutuante", "chat-open" in (page.locator("#chat-panel").get_attribute("class") or ""))

        check("Mensagem de boas-vindas aparece ao abrir", page.locator("#chat-body").inner_text() != "")
        welcome_text = page.locator("#chat-body").inner_text().lower()
        check("Mensagem de boas-vindas menciona confirmação antes de gravar", "confirm" in welcome_text or "decide" in welcome_text)

        page.click("#chat-toggle-btn")
        page.wait_for_timeout(200)
        check("Painel fecha ao clicar de novo no botão flutuante", "chat-open" not in (page.locator("#chat-panel").get_attribute("class") or ""))

        # ---- Enviar mensagem sem chave configurada: deve mostrar erro claro, não travar ----
        page.click("#chat-toggle-btn")
        page.wait_for_timeout(200)
        page.fill("#chat-input", "oi, tudo bem?")
        page.click("#chat-send-btn")
        page.wait_for_timeout(800)

        chat_body_text = page.locator("#chat-body").inner_text().lower()
        check("Mensagem do usuário aparece no chat", "oi, tudo bem" in chat_body_text)
        check(
            "Sem chave configurada, aparece uma mensagem de erro clara (não trava, não fica girando para sempre)",
            "indisponível" in chat_body_text or "gemini" in chat_body_text or "chave" in chat_body_text,
        )
        check("Indicador de 'digitando' desaparece depois da resposta (mesmo sendo erro)", page.locator("#chat-typing-indicator").count() == 0)

        # ---- Confirmar que o botão de enviar não fica travado em disabled depois do erro ----
        check("Botão de enviar volta a ficar habilitado depois do erro", not page.locator("#chat-send-btn").is_disabled())

        # ---- Testar a renderização de pendência DIRETAMENTE via JS, simulando o que o servidor
        # devolveria com uma chave real e uma ferramenta de escrita pedida pelo Gemini — sem
        # depender da API real, cobrindo a lógica de renderização e confirmação client-side. ----
        page.evaluate("""
            chatAddPendencia('999', 'aprovar_projeto_gg', {
                nomeProjeto: 'Projeto Simulado',
                equipe: [{tipo:'mem', qtd:2, semanas:4, hSem:6}],
                precoAprovado: 5000
            });
        """)
        page.wait_for_timeout(200)
        pendencia_text = page.locator(".chat-pendencia").last.inner_text().lower()
        check("Card de pendência renderiza com o nome do projeto", "projeto simulado" in pendencia_text)
        check("Card de pendência mostra o valor formatado em reais", "5.000" in pendencia_text or "5000" in pendencia_text)
        check("Card de pendência tem botão Confirmar", page.locator(".chat-pendencia").last.get_by_text("Confirmar").count() > 0)
        check("Card de pendência tem botão Cancelar", page.locator(".chat-pendencia").last.get_by_text("Cancelar").count() > 0)

        # ---- Cancelar a pendência simulada: não deve chamar o servidor, só mudar visualmente ----
        page.locator(".chat-pendencia").last.get_by_text("Cancelar").click()
        page.wait_for_timeout(200)
        cancelada_text = page.locator(".chat-pendencia").last.inner_text().lower()
        check("Após cancelar, o card muda para 'ação cancelada' sem chamar o servidor", "cancelada" in cancelada_text)

        browser.close()

finally:
    server_proc.terminate()
    try:
        server_proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server_proc.kill()

print("\n=== RESULT ===")
passed = sum(1 for r in results if r)
total = len(results)
print(f"PASS: {passed}/{total}")
sys.exit(0 if passed == total else 1)
