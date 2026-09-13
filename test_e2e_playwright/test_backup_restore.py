import subprocess
import time
import sys
import os
import json
from playwright.sync_api import sync_playwright

import pathlib
PROJECT_DIR = str(pathlib.Path(__file__).resolve().parent.parent)
TEST_DB_URL = "postgresql://postgres:quaratest@localhost:5432/quara_test"

subprocess.run(
    [
        "psql",
        TEST_DB_URL,
        "-c",
        "TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides, gg_projetos, fin_lancamentos, fin_config RESTART IDENTITY",
    ],
    check=True,
    capture_output=True,
)

env = os.environ.copy()
env["PORT"] = "3458"
env["DATABASE_URL"] = TEST_DB_URL
server_proc = subprocess.Popen(
    ["node", "server.js"],
    cwd=PROJECT_DIR,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
)

BASE_URL = "http://localhost:3458"
results = []


def check(desc, cond):
    status = "OK" if cond else "FAIL"
    print(f"{status}: {desc}")
    results.append(cond)


try:
    time.sleep(1.5)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1100, "height": 900}, accept_downloads=True)
        page.goto(BASE_URL)
        page.wait_for_timeout(800)
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

        hist_rows_before = page.locator("#qr-historico .qr-hist-row").count()
        check("Semeado: histórico tem 2 linhas antes do backup", hist_rows_before == 2)

        with page.expect_download() as download_info:
            page.click("text=Backup")
        download = download_info.value
        backup_path = "/tmp/quara_backup_test.json"
        download.save_as(backup_path)

        with open(backup_path, "r", encoding="utf-8") as f:
            backup_content = json.load(f)
        check("Backup baixado é um JSON válido numa versão suportada", backup_content.get("versao") in (1, 2))
        check("Backup contém as 2 entradas de histórico semeadas", len(backup_content.get("historico", [])) == 2)
        check("Backup contém a entrada aplicada", len(backup_content.get("aplicados", [])) >= 1)
        check("Backup contém os valores de limiares", len(backup_content.get("limiar_valores", [])) == 2)

        subprocess.run(
            [
                "psql",
                TEST_DB_URL,
                "-c",
                "TRUNCATE historico, aplicados, silenciados, limiar_valores, limiar_contagem, limiar_log, servico_overrides, gg_projetos, fin_lancamentos, fin_config RESTART IDENTITY",
            ],
            check=True,
            capture_output=True,
        )

        page.reload()
        page.wait_for_timeout(800)
        page.get_by_role("button", name="Quara AI").click()
        page.wait_for_timeout(500)
        hist_rows_after_wipe = page.locator("#qr-historico .qr-hist-row").count()
        check("Depois de apagar tudo, histórico fica vazio (confirma que o TRUNCATE funcionou de verdade)", hist_rows_after_wipe == 0)

        page.once("dialog", lambda dialog: dialog.accept())
        with page.expect_file_chooser() as fc_info:
            page.click("text=Restaurar")
        file_chooser = fc_info.value
        file_chooser.set_files(backup_path)
        page.wait_for_timeout(1500)

        page.wait_for_timeout(1000)
        page.get_by_role("button", name="Quara AI").click()
        page.wait_for_timeout(500)
        hist_rows_after_restore = page.locator("#qr-historico .qr-hist-row").count()
        check("Depois de restaurar, histórico volta a ter 2 linhas", hist_rows_after_restore == 2)

        applied_card_after_restore = page.locator('[data-qr-id="hist-0"]')
        check(
            "Depois de restaurar, o ajuste aplicado também volta (min/max override restaurado)",
            applied_card_after_restore.count() > 0 and "qr-done" in (applied_card_after_restore.get_attribute("class") or ""),
        )

        limiares_response = page.evaluate("fetch('/api/limiares').then(r => r.json())")
        check(
            "Limiares restaurados corretamente (desvioHist presente e numérico)",
            "desvioHist" in limiares_response.get("valores", {}),
        )

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
