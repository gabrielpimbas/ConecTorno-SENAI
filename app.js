(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const cfg = window.CONECTORNO_CONFIG || {};

  const configured =
    /^https:\/\//.test(cfg.supabaseUrl || "") &&
    cfg.supabaseAnonKey &&
    !cfg.supabaseAnonKey.includes("COLE_AQUI");

  const sb =
    configured && window.supabase
      ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
      : null;

  const BUCKET = "conectorno-arquivos";

  // SHA-256 da senha de saída do modo monitor (senai@123).
  // Para trocar: gere o SHA-256 da nova senha e substitua o valor abaixo.
  const EXIT_PASSWORD_SHA256 =
    "57dbc5597ec304807a8dfd7e3d4d587b78369f232e3c796fafa955dbf9b39dae";

  // Visualização de PDF (PDF.js): cada página é desenhada como uma folha.
  const PDF_WORKER =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const PDF_PAGE_SECONDS = 15;

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  }

  let pdf = null;

  let session = null;
  let mode = "login";
  let entries = [];
  let signedCache = new Map();
  let channel = null;
  let pollTimer = null;
  let reloadBusy = false;
  let ticket = 0;
  let isAdmin = false;

  const views = {
    login: $("loginView"),
    choose: $("chooseView"),
    teacher: $("teacherView"),
    monitor: $("monitorView"),
  };

  function show(name) {
    mode = name;

    Object.entries(views).forEach(([key, view]) => {
      view.classList.toggle("hidden", key !== name);
    });

    window.scrollTo(0, 0);
  }

  function toast(message, isError = false) {
    const el = $("toast");

    el.textContent = message;
    el.classList.toggle("error", isError);
    el.classList.add("show");

    clearTimeout(el._time);

    el._time = setTimeout(() => {
      el.classList.remove("show");
    }, 4200);
  }

  function busy(id, on) {
    $(id).disabled = on;
  }

  function errMessage(error) {
    return (error && error.message) || "Ocorreu um erro. Tente novamente.";
  }

  function dateText(value) {
    try {
      return new Date(value).toLocaleString("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      });
    } catch {
      return "";
    }
  }

  function safeName(value) {
    return (value || "arquivo").replace(/[^\w.\-]/g, "_").slice(0, 90);
  }

  function validFile(file) {
    const types = ["image/png", "image/jpeg", "image/webp", "application/pdf"];

    return types.includes(file.type) && file.size <= 20 * 1024 * 1024;
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  }

  async function authCheck() {
    if (!sb) {
      $("configError").textContent =
        "Configure config.js com a URL e a chave pública do Supabase.";

      $("configError").classList.remove("hidden");
      return;
    }

    const { data } = await sb.auth.getSession();

    session = data.session;

    if (session) {
      await enterChoice();
    }
  }

  async function checkAdmin() {
    if (!session) return false;

    const { data, error } = await sb
      .from("administradores")
      .select("usuario_id")
      .eq("usuario_id", session.user.id)
      .maybeSingle();

    if (error) throw error;

    return !!data;
  }

  async function enterChoice() {
    if (!session) {
      show("login");
      return;
    }

    try {
      isAdmin = await checkAdmin();

      if (!isAdmin) {
        await sb.auth.signOut();

        session = null;

        show("login");

        toast(
          "Esta conta não está autorizada a administrar o ConecTorno.",
          true,
        );

        return;
      }

      $("accountLabel").textContent = session.user.email || "";

      stopUpdates();
      show("choose");
    } catch (error) {
      show("login");

      toast("Falha ao verificar acesso: " + errMessage(error), true);
    }
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!sb) {
      toast("Configure o Supabase em config.js.", true);
      return;
    }

    busy("loginBtn", true);

    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: $("email").value.trim(),
        password: $("password").value,
      });

      if (error) throw error;

      session = data.session;

      $("password").value = "";

      await enterChoice();
    } catch (error) {
      toast("Não foi possível entrar: " + errMessage(error), true);
    } finally {
      busy("loginBtn", false);
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    stopUpdates();

    await sb.auth.signOut();

    session = null;
    isAdmin = false;

    show("login");
  });

  $("professorChoice").addEventListener("click", () => {
    show("teacher");
    startUpdates();
  });

  $("monitorChoice").addEventListener("click", async () => {
    resetViewer();
    show("monitor");
    startUpdates();

    try {
      await document.documentElement.requestFullscreen();
    } catch {
      toast("O navegador não conseguiu ativar a tela cheia.");
    }
  });

  $("backFromTeacher").addEventListener("click", () => {
    enterChoice();
  });

  $("refreshBtn").addEventListener("click", () => {
    loadEntries(true);
  });

  $("fileInput").addEventListener("change", () => {
    const file = $("fileInput").files[0];

    $("fileLabel").textContent = file
      ? file.name
      : "Clique para selecionar um arquivo";
  });

  $("uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const file = $("fileInput").files[0];

    if (!file) {
      toast("Selecione um arquivo.", true);
      return;
    }

    if (!validFile(file)) {
      toast("Formato inválido ou arquivo maior que 20 MB.", true);
      return;
    }

    busy("uploadBtn", true);

    let path = null;

    try {
      path = `${session.user.id}/${crypto.randomUUID()}-${safeName(file.name)}`;

      const uploaded = await sb.storage.from(BUCKET).upload(path, file, {
        contentType: file.type,
        upsert: false,
      });

      if (uploaded.error) {
        throw uploaded.error;
      }

      const inserted = await sb.from("conteudos").insert({
        tipo: file.type === "application/pdf" ? "pdf" : "imagem",
        titulo: $("fileTitle").value.trim() || file.name,
        caminho: path,
        mime: file.type,
        autor: session.user.id,
      });

      if (inserted.error) {
        await sb.storage.from(BUCKET).remove([path]);
        throw inserted.error;
      }

      $("uploadForm").reset();

      $("fileLabel").textContent = "Clique para selecionar um arquivo";

      toast("Arquivo publicado no monitor!");

      await loadEntries(true);
    } catch (error) {
      toast("Erro ao publicar: " + errMessage(error), true);
    } finally {
      busy("uploadBtn", false);
    }
  });

  $("messageForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    const texto = $("messageText").value.trim();

    if (!texto) return;

    busy("messageBtn", true);

    try {
      const { error } = await sb.from("conteudos").insert({
        tipo: "mensagem",
        titulo: texto,
        autor: session.user.id,
      });

      if (error) throw error;

      $("messageForm").reset();

      toast("Mensagem publicada!");

      await loadEntries(true);
    } catch (error) {
      toast("Falha ao publicar mensagem: " + errMessage(error), true);
    } finally {
      busy("messageBtn", false);
    }
  });

  async function deleteEntry(row) {
    if (!confirm("Remover este conteúdo da apresentação?")) {
      return;
    }

    try {
      const { error } = await sb.from("conteudos").delete().eq("id", row.id);

      if (error) throw error;

      if (row.caminho) {
        const result = await sb.storage.from(BUCKET).remove([row.caminho]);

        if (result.error) {
          toast(
            "Conteúdo removido, mas o arquivo não foi apagado do Storage.",
            true,
          );
        }
      }

      signedCache.delete(row.caminho);

      toast("Conteúdo removido.");

      await loadEntries(true);
    } catch (error) {
      toast("Falha ao remover: " + errMessage(error), true);
    }
  }

  async function getUrl(path) {
    if (!path) return null;

    const cached = signedCache.get(path);

    if (cached && cached.expires > Date.now() + 30000) {
      return cached.url;
    }

    const { data, error } = await sb.storage
      .from(BUCKET)
      .createSignedUrl(path, 3600);

    if (error) throw error;

    signedCache.set(path, {
      url: data.signedUrl,
      expires: Date.now() + 3600 * 1000,
    });

    return data.signedUrl;
  }

  async function loadEntries(notify = false) {
    if (!session || reloadBusy) return;

    reloadBusy = true;

    const id = ++ticket;

    try {
      const { data, error } = await sb
        .from("conteudos")
        .select("id,tipo,titulo,caminho,mime,criado_em")
        .order("criado_em", { ascending: false })
        .limit(100);

      if (error) throw error;

      if (id !== ticket) return;

      entries = data || [];

      if (mode === "teacher") {
        renderTeacher();
      }

      if (mode === "monitor") {
        await renderMonitor();
      }

      $("connectionStatus").textContent = "● Conectado";
      $("connectionStatus").className = "online";
    } catch (error) {
      if (mode === "monitor") {
        $("connectionStatus").textContent = "● Sem conexão";
        $("connectionStatus").className = "offline";
      }

      if (notify) {
        toast("Erro ao atualizar: " + errMessage(error), true);
      } else {
        console.error("ConecTorno sync", error);
      }
    } finally {
      reloadBusy = false;
    }
  }

  function renderTeacher() {
    const list = $("itemsList");

    list.replaceChildren();

    if (!entries.length) {
      list.append(
        make("p", "muted", "Nenhum arquivo ou mensagem publicado ainda."),
      );

      return;
    }

    for (const row of entries) {
      const item = make("div", "content-item");
      const left = make("div", "item-left");

      const icon = make(
        "span",
        "item-icon" + (row.tipo === "mensagem" ? " msg" : ""),
        row.tipo === "pdf" ? "PDF" : row.tipo === "imagem" ? "▧" : "✎",
      );

      const info = make("div", "item-info");

      const title = make("strong", "", row.titulo || "Sem título");

      const time = make(
        "small",
        "",
        `${
          row.tipo === "mensagem"
            ? "Mensagem"
            : row.tipo === "pdf"
              ? "PDF"
              : "Imagem"
        } · ${dateText(row.criado_em)}`,
      );

      const remove = make("button", "delete-btn", "Remover");

      remove.type = "button";

      remove.addEventListener("click", () => {
        deleteEntry(row);
      });

      info.append(title, time);
      left.append(icon, info);
      item.append(left, remove);
      list.append(item);
    }
  }

  async function renderMonitor() {
    const current = ticket;

    const file = entries.find(
      (item) => item.tipo === "imagem" || item.tipo === "pdf",
    );

    const messages = entries
      .filter((item) => item.tipo === "mensagem")
      .slice(0, 3);

    $("monitorEmpty").classList.toggle("hidden", !!file || !!messages.length);

    $("monitorFile").classList.toggle("hidden", !file);

    $("monitorMessages").classList.toggle("hidden", !messages.length);

    const cards = $("messageCards");

    cards.replaceChildren();

    messages.forEach((item) => {
      cards.append(make("div", "message-card", item.titulo));
    });

    const viewer = $("viewer");

    if (!file) {
      resetViewer();
      return;
    }

    if (viewer.dataset.path === file.caminho) {
      return;
    }

    const stillHere = () => current === ticket && mode === "monitor";

    try {
      if (file.tipo === "pdf") {
        if (!viewer.childElementCount) {
          viewer.replaceChildren(make("div", "viewer-loading", "Carregando…"));
        }

        if (!(await showPdf(file, stillHere))) return;
      } else {
        const url = await getUrl(file.caminho);

        if (!stillHere()) return;

        const img = make("img", "sheet image-sheet");

        img.src = url;
        img.alt = file.titulo || "Imagem do projeto";

        clearPdf();
        viewer.replaceChildren(img);
        animateSheet(img);
      }

      viewer.dataset.path = file.caminho;

      $("displayTitle").textContent = file.titulo;
      $("displayTime").textContent = dateText(file.criado_em);
    } catch (error) {
      console.error("ConecTorno viewer", error);
      clearPdf();

      viewer.replaceChildren(
        make(
          "p",
          "viewer-error",
          "Não foi possível carregar o arquivo: " + errMessage(error),
        ),
      );

      viewer.dataset.path = "";
    }
  }

  function animateSheet(element) {
    element.classList.remove("turn");
    void element.offsetWidth;
    element.classList.add("turn");
  }

  function clearPdf() {
    if (!pdf) return;

    clearTimeout(pdf.timer);

    if (pdf.task) pdf.task.cancel();

    pdf.doc.destroy();
    pdf = null;
  }

  function resetViewer() {
    clearPdf();

    const viewer = $("viewer");

    viewer.replaceChildren();
    viewer.dataset.path = "";
  }

  // Baixa o PDF e mostra a primeira página como uma folha (sem a barra
  // do visualizador do navegador). PDFs com várias páginas avançam sozinhos.
  async function showPdf(file, stillHere) {
    const viewer = $("viewer");

    if (!window.pdfjsLib) {
      // Sem PDF.js (CDN bloqueada): visualizador nativo, sem barras.
      const url = await getUrl(file.caminho);

      if (!stillHere()) return false;

      clearPdf();

      const frame = make("iframe", "pdf-fallback");

      frame.src = url + "#toolbar=0&navpanes=0&scrollbar=0&view=Fit";
      frame.title = file.titulo || "PDF do projeto";

      viewer.replaceChildren(frame);
      return true;
    }

    const { data: blob, error } = await sb.storage
      .from(BUCKET)
      .download(file.caminho);

    if (error) throw error;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;

    if (!stillHere()) {
      doc.destroy();
      return false;
    }

    clearPdf();

    const sheet = make("div", "sheet pdf-sheet");
    const nodes = [sheet];
    let pager = null;

    if (doc.numPages > 1) {
      pager = make("div", "pdf-pager");
      pager.append(make("span", "pdf-pager-label"), make("span", "pdf-pager-bar"));
      pager.lastChild.append(make("i"));
      nodes.push(pager);
    }

    viewer.replaceChildren(...nodes);

    pdf = { doc, sheet, pager, page: 1, timer: null, task: null };

    await drawPdfPage();
    return true;
  }

  async function drawPdfPage() {
    const state = pdf;

    if (!state) return;

    clearTimeout(state.timer);

    const page = await state.doc.getPage(state.page);

    if (pdf !== state) return;

    const viewer = $("viewer");
    const pad = 28;
    const pagerSpace = state.pager ? 46 : 0;
    const availW = Math.max(80, viewer.clientWidth - pad * 2);
    const availH = Math.max(80, viewer.clientHeight - pad * 2 - pagerSpace);

    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(availW / base.width, availH / base.height);

    // Renderiza na resolução real da tela para o texto ficar nítido.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    let scale = fit * dpr * 1.25;
    const maxPixels = 24e6;
    const area = base.width * base.height * scale * scale;

    if (area > maxPixels) scale *= Math.sqrt(maxPixels / area);

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(base.width * fit) + "px";
    canvas.style.height = Math.floor(base.height * fit) + "px";

    if (state.task) state.task.cancel();

    const task = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      background: "#ffffff",
    });

    state.task = task;

    try {
      await task.promise;
    } catch (error) {
      if (error && error.name === "RenderingCancelledException") return;
      throw error;
    } finally {
      if (state.task === task) state.task = null;
    }

    if (pdf !== state) return;

    state.sheet.replaceChildren(canvas);
    animateSheet(state.sheet);

    if (state.pager) {
      const total = state.doc.numPages;

      state.pager.firstChild.textContent = `PÁGINA ${state.page} DE ${total}`;
      state.pager.style.setProperty("--page-time", PDF_PAGE_SECONDS + "s");
      animateSheet(state.pager);

      state.timer = setTimeout(() => {
        turnPdfPage(1);
      }, PDF_PAGE_SECONDS * 1000);
    }
  }

  function turnPdfPage(step) {
    if (!pdf || pdf.doc.numPages < 2) return;

    const total = pdf.doc.numPages;

    pdf.page = ((pdf.page - 1 + step + total) % total) + 1;

    drawPdfPage().catch((error) => console.error("ConecTorno PDF", error));
  }

  // Ajusta a folha quando a tela muda de tamanho (ex.: ao entrar em tela cheia).
  let resizeTimer = null;

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);

    resizeTimer = setTimeout(() => {
      if (pdf && mode === "monitor") {
        drawPdfPage().catch((error) => console.error("ConecTorno PDF", error));
      }
    }, 250);
  });

  function stopUpdates() {
    if (channel) {
      sb?.removeChannel(channel);
      channel = null;
    }

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    ticket++;
  }

  function startUpdates() {
    stopUpdates();

    loadEntries(true);

    if (!sb) return;

    channel = sb
      .channel("conectorno-conteudos")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conteudos",
        },
        () => loadEntries(),
      )
      .subscribe();

    pollTimer = setInterval(() => {
      loadEntries();
    }, 5000);
  }

  function openExit() {
    if (mode !== "monitor") return;

    $("exitError").textContent = "";
    $("exitPassword").value = "";

    $("exitModal").classList.remove("hidden");

    setTimeout(() => {
      $("exitPassword").focus();
    }, 30);
  }

  function closeExit() {
    $("exitModal").classList.add("hidden");
    $("exitPassword").value = "";
  }

  async function checkExitPassword(typed) {
    if (window.crypto && window.crypto.subtle) {
      const digest = await window.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(typed),
      );

      const hex = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");

      return hex === EXIT_PASSWORD_SHA256;
    }

    // Página aberta fora de https/localhost: confere com a senha da conta.
    const { error } = await sb.auth.signInWithPassword({
      email: session.user.email,
      password: typed,
    });

    return !error;
  }

  // Atalho oculto para solicitar a saída do monitor.
  document.addEventListener("keydown", (event) => {
    // Setas trocam a página do PDF manualmente no monitor.
    if (
      mode === "monitor" &&
      $("exitModal").classList.contains("hidden") &&
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
    ) {
      event.preventDefault();
      turnPdfPage(event.key === "ArrowRight" ? 1 : -1);
    }

    if (
      mode === "monitor" &&
      event.ctrlKey &&
      event.key.toLowerCase() === "x"
    ) {
      event.preventDefault();
      openExit();
    }

    if (
      event.key === "Escape" &&
      !$("exitModal").classList.contains("hidden")
    ) {
      event.preventDefault();
      closeExit();
    }
  });

  $("cancelExit").addEventListener("click", closeExit);

  $("exitForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!session) return;

    busy("confirmExit", true);

    try {
      if (!(await checkExitPassword($("exitPassword").value))) {
        throw new Error("Senha incorreta");
      }

      closeExit();
      stopUpdates();
      resetViewer();

      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => {});
      }

      await enterChoice();

      toast("Modo monitor encerrado.");
    } catch (error) {
      $("exitError").textContent = "Senha incorreta.";
    } finally {
      busy("confirmExit", false);
    }
  });

  // A saída da tela cheia não revela o atalho secreto.
  document.addEventListener("fullscreenchange", () => {
    if (mode === "monitor" && !document.fullscreenElement) {
      toast("A exibição em tela cheia foi encerrada.");
    }
  });

  authCheck();
})();
