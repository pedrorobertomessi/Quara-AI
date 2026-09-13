import subprocess
import time
import sys
import os
from playwright.sync_api import sync_playwright

import pathlib
PROJECT_DIR = str(pathlib.Path(__file__).resolve().parent.parent)
TEST_DB_URL = "postgresql://postgres:quaratest@localhost:5432/quara_test"

subprocess.run(
    [
        "psql",
        TEST_DB_URL,
        "-c",
        "TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides RESTART IDENTITY",
    ],
    check=True,
    capture_output=True,
)

env = os.environ.copy()
env["PORT"] = "3457"
env["DATABASE_URL"] = TEST_DB_URL
server_proc = subprocess.Popen(
    ["node", "server.js"],
    cwd=PROJECT_DIR,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)

BASE_URL = "http://localhost:3457"
results = []


def check(desc, cond):
    status = "OK" if cond else "FAIL"
    print(f"{status}: {desc}")
    results.append(cond)


def is_real_error(e):
    low = e.lower()
    return "403" not in e and "chart" not in low and "cdnjs" not in low


try:
    time.sleep(1.5)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 900})
        console_errors = []
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda err: console_errors.append(str(err)))

        page.goto(BASE_URL)
        page.wait_for_timeout(800)

        check("Dashboard: KPIs renderizam", page.locator("#kpi-dash").count() > 0)
        resumo_rows = page.locator("#tbody-resumo tr").count()
        check("Dashboard: tabela de resumo tem as 13 linhas de serviços", resumo_rows == 13)

        page.get_by_role("button", name="Custos", exact=True).click()
        page.wait_for_timeout(400)
        check("Custos: painel fica visível", "on" in (page.locator("#panel-custos").get_attribute("class") or ""))
        srv_sel_count = page.locator("#srv-sel button, #srv-sel .srv-item").count()
        check("Custos: seletor de serviço tem itens", srv_sel_count > 0)

        page.get_by_role("button", name="Preços", exact=True).click()
        page.wait_for_timeout(400)
        check("Preços: painel fica visível", "on" in (page.locator("#panel-precos").get_attribute("class") or ""))
        precos_rows = page.locator("#tbody-precos tr").count()
        check("Preços: tabela tem as 13 linhas de serviços", precos_rows == 13)

        preco_row0_before = page.locator("#tbody-precos tr").nth(0)
        cells_before = preco_row0_before.locator("td").all_inner_texts()
        preco_sugerido_before = cells_before[4].strip()
        print("Preço sugerido ANTES do ajuste da Quara:", preco_sugerido_before)

        page.get_by_role("button", name="Simulador", exact=True).click()
        page.wait_for_timeout(400)
        check("Simulador: painel fica visível", "on" in (page.locator("#panel-sim").get_attribute("class") or ""))
        sim_srv_count = page.locator("#sim-srv option").count()
        check("Simulador: seletor de serviço populado com 13 opções", sim_srv_count == 13)

        page.get_by_role("button", name="Config.", exact=True).click()
        page.wait_for_timeout(400)
        check("Config: painel fica visível", "on" in (page.locator("#panel-cfg").get_attribute("class") or ""))

        page.get_by_role("button", name="Quara AI").click()
        page.wait_for_timeout(500)

        page.select_option("#qr-save-srv", "0")
        page.fill("#qr-save-preco", "5000")
        page.locator("#panel-quara button.btn-r", has_text="Registrar").click()
        page.wait_for_timeout(300)
        page.select_option("#qr-save-srv", "0")
        page.fill("#qr-save-preco", "4700")
        page.locator("#panel-quara button.btn-r", has_text="Registrar").click()
        page.wait_for_timeout(400)

        hist_card = page.locator('[data-qr-id="hist-0"]')
        if hist_card.count() > 0 and hist_card.locator(".qr-btn-apply").count() > 0:
            hist_card.locator(".qr-btn-apply").click()
            page.wait_for_timeout(500)

        page.get_by_role("button", name="Preços", exact=True).click()
        page.wait_for_timeout(400)
        preco_row0_after = page.locator("#tbody-precos tr").nth(0)
        cells_after = preco_row0_after.locator("td").all_inner_texts()
        preco_sugerido_after = cells_after[4].strip()
        print("Preço sugerido DEPOIS do ajuste da Quara (mesmo navegador):", preco_sugerido_after)
        check("Preços (mesmo navegador): valor muda de verdade após aplicar via Quara", preco_sugerido_before != preco_sugerido_after)

        page2 = browser.new_page(viewport={"width": 1100, "height": 900})
        page2.goto(BASE_URL)
        page2.wait_for_timeout(1000)
        page2.get_by_role("button", name="Preços", exact=True).click()
        page2.wait_for_timeout(400)
        preco_row0_page2 = page2.locator("#tbody-precos tr").nth(0)
        cells_page2 = preco_row0_page2.locator("td").all_inner_texts()
        preco_sugerido_page2 = cells_page2[4].strip()
        print("Preço sugerido no SEGUNDO navegador (nunca visitou a aba Quara):", preco_sugerido_page2)
        check(
            "Preços (segundo navegador, SEM visitar Quara): já mostra o valor ajustado, não o original",
            preco_sugerido_page2 == preco_sugerido_after,
        )

        real_errors = [e for e in console_errors if is_real_error(e)]
        check("Nenhum erro JS inesperado no console durante todo o fluxo (Chart.js/CDN ignorado)", len(real_errors) == 0)
        if real_errors:
            print("Unexpected console errors:", real_errors)

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
