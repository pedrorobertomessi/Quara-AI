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
env["PORT"] = "3460"
env["DATABASE_URL"] = TEST_DB_URL
server_proc = subprocess.Popen(
    ["node", "server.js"],
    cwd=PROJECT_DIR,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)

BASE_URL = "http://localhost:3460"
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

        page.get_by_role("button", name="Aprovação GG").click()
        page.wait_for_timeout(400)
        check("Aba Aprovação GG abre corretamente", "on" in (page.locator("#panel-gg").get_attribute("class") or ""))

        check("Uma linha de equipe já existe por padrão ao abrir a aba", page.locator("#gg-equipe-tbody tr").count() == 1)

        page.fill("#gg-nome-projeto", "Projeto Teste E2E")
        row0 = page.locator("#gg-equipe-tbody tr").nth(0)
        row0.locator("select").select_option("ger")
        row0.locator("input").nth(1).fill("1")
        row0.locator("input").nth(2).fill("8")
        row0.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)

        page.locator("#panel-gg").get_by_text("Adicionar").click()
        page.wait_for_timeout(200)
        check("Botão Adicionar cria uma segunda linha de equipe", page.locator("#gg-equipe-tbody tr").count() == 2)

        row1 = page.locator("#gg-equipe-tbody tr").nth(1)
        row1.locator("select").select_option("mem")
        row1.locator("input").nth(1).fill("2")
        row1.locator("input").nth(2).fill("8")
        row1.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)

        page.click("text=Calcular preço sugerido")
        page.wait_for_timeout(500)
        check("Card de resultado aparece após calcular", page.locator("#gg-resultado-card").is_visible())
        resultado_lower = page.locator("#gg-resultado").inner_text().lower()
        check("Resultado mostra 'Custo total'", "custo total" in resultado_lower)
        check("Resultado mostra 'Preço sugerido'", "preço sugerido" in resultado_lower)
        check(
            "Sem histórico ainda, mostra a mensagem de que ainda não há comparação",
            "primeiro ponto de referência" in resultado_lower or "não há projetos" in resultado_lower,
        )

        preco_input_value = page.input_value("#gg-preco-aprovado")
        check("Campo de valor aprovado já vem pré-preenchido com o sugerido", preco_input_value != "" and preco_input_value != "0")

        page.click("text=Registrar aprovação")
        page.wait_for_timeout(500)

        check("Após aprovar, o formulário de nome do projeto é limpo", page.input_value("#gg-nome-projeto") == "")
        check("Após aprovar, o card de resultado esconde de novo", not page.locator("#gg-resultado-card").is_visible())

        hist_rows = page.locator("#gg-historico .qr-hist-row").count()
        check("Histórico de projetos mostra 1 linha após a primeira aprovação", hist_rows == 1)
        hist_text = page.locator("#gg-historico").inner_text()
        check("Histórico mostra o nome do projeto aprovado", "Projeto Teste E2E" in hist_text)

        page.fill("#gg-nome-projeto", "Projeto Teste E2E 2")
        row0b = page.locator("#gg-equipe-tbody tr").nth(0)
        row0b.locator("select").select_option("ger")
        row0b.locator("input").nth(1).fill("1")
        row0b.locator("input").nth(2).fill("8")
        row0b.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)
        page.locator("#panel-gg").get_by_text("Adicionar").click()
        page.wait_for_timeout(200)
        row1b = page.locator("#gg-equipe-tbody tr").nth(1)
        row1b.locator("select").select_option("mem")
        row1b.locator("input").nth(1).fill("2")
        row1b.locator("input").nth(2).fill("8")
        row1b.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)
        page.click("text=Calcular preço sugerido")
        page.wait_for_timeout(500)

        resultado_lower_2 = page.locator("#gg-resultado").inner_text().lower()
        check(
            "Com apenas 1 projeto anterior no histórico, ainda não mostra comparação (exige >=2 parecidos)",
            "primeiro ponto de referência" in resultado_lower_2 or "não há projetos" in resultado_lower_2,
        )

        page.fill("#gg-preco-aprovado", "9500")
        page.click("text=Registrar aprovação")
        page.wait_for_timeout(500)

        hist_rows_2 = page.locator("#gg-historico .qr-hist-row").count()
        check("Histórico mostra 2 linhas após a segunda aprovação", hist_rows_2 == 2)

        page.fill("#gg-nome-projeto", "Projeto Teste E2E 3")
        row0c = page.locator("#gg-equipe-tbody tr").nth(0)
        row0c.locator("select").select_option("ger")
        row0c.locator("input").nth(1).fill("1")
        row0c.locator("input").nth(2).fill("8")
        row0c.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)
        page.locator("#panel-gg").get_by_text("Adicionar").click()
        page.wait_for_timeout(200)
        row1c = page.locator("#gg-equipe-tbody tr").nth(1)
        row1c.locator("select").select_option("mem")
        row1c.locator("input").nth(1).fill("2")
        row1c.locator("input").nth(2).fill("8")
        row1c.locator("input").nth(0).fill("6")
        page.wait_for_timeout(200)
        page.click("text=Calcular preço sugerido")
        page.wait_for_timeout(500)

        resultado_lower_3 = page.locator("#gg-resultado").inner_text().lower()
        check("Com 2 projetos parecidos no histórico, a comparação AGORA aparece", "comparação com projetos parecidos" in resultado_lower_3)
        check("Comparação menciona a amostra usada", "2 projeto" in resultado_lower_3)

        api_lista = page.evaluate("fetch('/api/gg-projetos').then(r => r.json())")
        check("API confirma 2 projetos REGISTRADOS (o terceiro foi calculado mas não aprovado, corretamente não conta)", len(api_lista) == 2)
        check("Todos os projetos têm campo equipe como lista (JSONB ok)", all(isinstance(p["equipe"], list) for p in api_lista))

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
