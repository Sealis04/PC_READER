import "./style.css";
import {
  State,
  CheckConnection,
  Signup,
  MyComputer,
  ReportNow,
  UpdateUser,
  StartReregistration,
  UnlockITSettings,
  LockITSettings,
  ITSettings,
  SaveServerURL,
  ChangePIN,
} from "../wailsjs/go/bound/App";

const root = document.getElementById("app");

// ---- tiny helpers ----

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(c ?? ""));
  return node;
}

function show(...nodes) {
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

function message(kind, text) {
  return el("div", { class: `msg ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}

function field(name, label, { value = "", type = "text", required = false, hint = "" } = {}) {
  const input = el("input", { type, name, id: `f-${name}`, value, required, autocomplete: "off", spellcheck: "false" });
  const error = el("span", { class: "field-error", id: `e-${name}` });
  input.setAttribute("aria-describedby", error.id);
  const wrap = el(
    "label",
    { for: input.id },
    el("span", {}, label, required ? " *" : "", required ? "" : el("span", { class: "opt" }, " (optional)")),
    input,
    hint ? el("span", { class: "muted" }, hint) : "",
    error,
  );
  return wrap;
}

function showFieldErrors(form, errors = {}) {
  for (const input of form.querySelectorAll("input")) {
    const msg = errors[input.name] ?? "";
    input.setAttribute("aria-invalid", msg ? "true" : "false");
    const span = form.querySelector(`#e-${input.name}`);
    if (span) span.textContent = msg;
  }
  const first = form.querySelector('input[aria-invalid="true"]');
  if (first) first.focus();
}

function busy(button, text, on) {
  if (on) {
    button.dataset.label = button.textContent;
    button.replaceChildren(el("span", { class: "spinner" }), text);
  } else {
    button.textContent = button.dataset.label;
  }
  button.disabled = on;
}

function userFields(user) {
  const u = user ?? {};
  return [
    el(
      "div",
      { class: "grid2" },
      field("fullName", "Full name", { value: u.fullName, required: true }),
      field("employeeId", "Employee ID", { value: u.employeeId, required: true }),
    ),
    field("department", "Department", { value: u.department, required: true }),
    el(
      "div",
      { class: "grid2" },
      field("position", "Position", { value: u.position }),
      field("phone", "Phone", { value: u.phone }),
    ),
    field("email", "Email", { value: u.email, type: "email" }),
  ];
}

function readUser(form) {
  const v = (n) => form.elements[n].value;
  return {
    fullName: v("fullName"),
    employeeId: v("employeeId"),
    department: v("department"),
    position: v("position"),
    phone: v("phone"),
    email: v("email"),
    policyAccepted: form.elements.policyAccepted ? form.elements.policyAccepted.checked : false,
  };
}

// ---- screens ----

async function start() {
  const st = await State();
  document.getElementById("version").textContent = `v${st.version}`;
  if (st.screen === "home") return home();
  if (st.screen === "signup") return signup(st);
  return setup(st);
}

function setup(st) {
  const banner = el("div");
  const askKey = st.needKey;
  const pinFields =
    st.needPin === "create"
      ? [
          field("pin", "IT PIN", { type: "password", required: true, hint: "4 to 8 digits. IT needs it later to change these settings." }),
          field("pinAgain", "Repeat the IT PIN", { type: "password", required: true }),
        ]
      : st.needPin === "verify"
        ? [field("pin", "IT PIN", { type: "password", required: true })]
        : [];
  const form = el(
    "form",
    { novalidate: true },
    field("serverUrl", "Server address", { value: st.serverUrl, required: true, hint: "For example http://192.168.1.10:3000" }),
    askKey ? field("key", "Enrollment key", { type: "password", required: true, hint: "Given to you by IT. It is not saved on this computer." }) : "",
    ...pinFields,
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, askKey ? "Check connection and continue" : "Check connection and save")),
  );
  const val = (n) => (form.elements[n] ? form.elements[n].value : "");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    busy(btn, "Checking…", true);
    const res = await CheckConnection(val("serverUrl"), val("key"), val("pin"), val("pinAgain"));
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    banner.replaceChildren(res.ok ? "" : message("error", res.message));
    if (!res.ok) return;
    if (askKey) return signup({ ...st, serverUrl: val("serverUrl") });
    home(res.message);
  });
  show(
    el("h1", {}, "IT setup"),
    el(
      "p",
      { class: "muted" },
      askKey
        ? "IT: enter the server address, the enrollment key and an IT PIN once. The person using this computer signs up next."
        : "IT: this computer is already registered. Confirm the server address and choose an IT PIN to protect these settings.",
    ),
    el("div", { class: "card" }, banner, form),
  );
}

function signup(st) {
  const banner = el("div");
  const form = el(
    "form",
    { novalidate: true },
    ...userFields(st.user),
    el("div", { class: "notice" }, st.notice),
    el(
      "label",
      { class: "check", for: "f-policyAccepted" },
      el("input", { type: "checkbox", name: "policyAccepted", id: "f-policyAccepted" }),
      "I have read the data-use notice and agree.",
    ),
    el("span", { class: "field-error", id: "e-policyAccepted" }),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => setup(st) }, "Back"),
      el("button", { type: "submit", class: "primary" }, "Sign up"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    busy(btn, "Scanning and registering — this can take up to a minute…", true);
    const res = await Signup(readUser(form));
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    if (res.ok) return home(res.message);
    banner.replaceChildren(message("error", res.message));
  });
  show(
    el("h1", {}, "Tell us who you are"),
    el("p", { class: "muted" }, "Fields marked * are required. You can change your details later."),
    el("div", { class: "card" }, banner, form),
  );
}

async function home(notice) {
  show(el("p", {}, el("span", { class: "spinner" }), "Reading this computer…"));
  const h = await MyComputer();
  if (!h.ok) {
    return show(message("error", h.message), el("button", { onclick: () => home() }, "Try again"));
  }
  renderHome(h, notice ? message("ok", notice) : "");
}

function dl(rows) {
  return el("dl", {}, rows.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

function renderHome(h, banner) {
  const s = h.summary;
  const u = h.assignedUser;
  const status = el("div", {}, banner);
  const reportBtn = el("button", { class: "primary" }, "Report now");
  reportBtn.addEventListener("click", async () => {
    busy(reportBtn, "Scanning and sending…", true);
    const res = await ReportNow();
    busy(reportBtn, "", false);
    if (res.ok) return renderHome(res.home, message("ok", res.message));
    status.replaceChildren(message("error", res.message));
    if (res.needsReregistration) status.append(reregisterButton());
  });

  const disks = s.disks.map((d) =>
    el(
      "div",
      { class: "disk" },
      `${d.name}: ${d.free} free of ${d.size}`,
      d.hasUsage ? el("div", { class: "bar", role: "img", "aria-label": `${d.usedPct}% used` }, el("span", { style: `width:${d.usedPct}%` })) : "",
    ),
  );

  const details = el(
    "details",
    { class: "card" },
    el("summary", {}, "Full details"),
    ...h.sections.map((sec) =>
      el(
        "details",
        {},
        el("summary", {}, sec.title),
        ...sec.entries.map((en) =>
          el("div", { class: "entry" }, en.heading ? el("h3", {}, en.heading) : "", dl(en.fields.map((f) => [f.label, f.value]))),
        ),
      ),
    ),
  );

  show(
    el("h1", {}, "My computer"),
    h.reported ? "" : el("p", { class: "muted" }, "These specs were just read from this computer and have not been sent to IT yet. Press “Report now”."),
    status,
    h.needsReregistration ? el("div", {}, message("error", h.message), reregisterButton()) : "",
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Summary"),
      dl([
        ["Computer name", s.computerName],
        ["Model", s.model],
        ["Serial number", s.serial],
        ["Operating system", s.os],
        ["Processor", s.cpu],
        ["Memory", s.memory],
        ["IP address", s.ipAddress],
        ["Assigned to", u ? `${u.fullName} (${u.employeeId}), ${u.department}` : "Not known on this computer"],
        ["Last report", h.lastReportAt],
      ]),
      el("div", { class: "disks", style: "margin-top:12px" }, ...disks),
    ),
    el("div", { class: "actions", style: "margin-bottom:16px" }, reportBtn, el("button", { onclick: () => editUser(h) }, "Update my details")),
    details,
    el("p", { class: "footer-link" }, el("button", { class: "link", onclick: () => itLogin() }, "IT settings")),
  );
}

// Registering again is an IT task, so it goes through the PIN like the other IT settings.
function reregisterButton() {
  return el("button", { class: "primary", onclick: () => itLogin() }, "Register this computer again (IT)");
}

function itLogin() {
  const banner = el("div");
  const form = el(
    "form",
    { novalidate: true },
    field("pin", "IT PIN", { type: "password", required: true }),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => home() }, "Cancel"),
      el("button", { type: "submit", class: "primary" }, "Open IT settings"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await UnlockITSettings(form.elements.pin.value);
    if (res.ok) return itSettings();
    form.elements.pin.value = "";
    showFieldErrors(form, {});
    banner.replaceChildren(message("error", res.message));
  });
  show(el("h1", {}, "IT settings"), el("p", { class: "muted" }, "Enter the IT PIN to continue."), el("div", { class: "card" }, banner, form));
}

async function itSettings(notice) {
  const cur = await ITSettings();
  if (!cur.ok) return itLogin();
  const leave = async () => {
    await LockITSettings();
    home();
  };

  const urlBanner = el("div", {}, notice ? message("ok", notice) : "");
  const urlForm = el(
    "form",
    { novalidate: true },
    field("serverUrl", "Server address", { value: cur.serverUrl, required: true, hint: "For example http://192.168.1.10:3000" }),
    el("div", { class: "actions" }, el("button", { type: "submit", class: "primary" }, "Check connection and save")),
  );
  urlForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = urlForm.querySelector("button");
    busy(btn, "Checking…", true);
    const res = await SaveServerURL(urlForm.elements.serverUrl.value);
    busy(btn, "", false);
    showFieldErrors(urlForm, res.fieldErrors ?? {});
    urlBanner.replaceChildren(message(res.ok ? "ok" : "error", res.message));
  });

  const pinBanner = el("div");
  const pinForm = el(
    "form",
    { novalidate: true },
    field("pin", "New IT PIN", { type: "password", required: true, hint: "4 to 8 digits" }),
    field("pinAgain", "Repeat the new PIN", { type: "password", required: true }),
    el("div", { class: "actions" }, el("button", { type: "submit" }, "Change PIN")),
  );
  pinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await ChangePIN(pinForm.elements.pin.value, pinForm.elements.pinAgain.value);
    showFieldErrors(pinForm, res.fieldErrors ?? {});
    pinBanner.replaceChildren(message(res.ok ? "ok" : "error", res.message));
    if (res.ok) pinForm.reset();
  });

  show(
    el("h1", {}, "IT settings"),
    el("div", { class: "card" }, el("h2", {}, "Server address"), urlBanner, urlForm),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "Register this computer again"),
      el("p", { class: "muted" }, "Needs the enrollment key and the user's details. The IT PIN stays the same."),
      el(
        "button",
        {
          onclick: async () => {
            const st = await StartReregistration();
            if (st.screen === "setup") return setup(st);
            itLogin();
          },
        },
        "Register this computer again",
      ),
    ),
    el("div", { class: "card" }, el("h2", {}, "Change the IT PIN"), pinBanner, pinForm),
    el("div", { class: "actions" }, el("button", { onclick: leave }, "Done")),
  );
}

function editUser(h) {
  const banner = el("div");
  const form = el(
    "form",
    { novalidate: true },
    ...userFields(h.assignedUser),
    el("p", { class: "muted" }, "Changing the employee ID moves this computer to that person."),
    el(
      "div",
      { class: "actions" },
      el("button", { type: "button", onclick: () => home() }, "Cancel"),
      el("button", { type: "submit", class: "primary" }, "Save"),
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    busy(btn, "Saving…", true);
    const res = await UpdateUser(readUser(form));
    busy(btn, "", false);
    showFieldErrors(form, res.fieldErrors ?? {});
    if (res.ok) return home(res.message);
    banner.replaceChildren(message("error", res.message));
    if (res.needsReregistration) banner.append(reregisterButton());
  });
  show(el("h1", {}, "Update my details"), el("div", { class: "card" }, banner, form));
}

start();
