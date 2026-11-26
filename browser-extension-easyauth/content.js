(() => {
  if (window.__foundryFormCopilotEasyAuthInjected) {
    return;
  }
  window.__foundryFormCopilotEasyAuthInjected = true;

  function ensureHighlightStyle() {
    if (document.getElementById("foundry-copilot-highlight-style")) return;
    const style = document.createElement("style");
    style.id = "foundry-copilot-highlight-style";
    style.textContent = `
      @keyframes foundryPulseGlow {
        0%   { box-shadow: 0 0 0 0 rgba(13, 148, 136, 0.55); background-color: #f0fdfa; }
        60%  { box-shadow: 0 0 0 5px rgba(13, 148, 136, 0.18); background-color: #ecfdf5; }
        100% { box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.35); }
      }
      .foundry-autofilled {
        animation: foundryPulseGlow 0.9s ease-out forwards !important;
        transition: box-shadow 0.3s ease, background-color 0.3s ease !important;
      }
    `;
    document.head.appendChild(style);
  }

  function cleanLabelNodeText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style, [aria-hidden="true"]').forEach((el) => el.remove());
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function resolveFieldLabel(el) {
    if (el.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit) {
        const txt = cleanLabelNodeText(explicit);
        if (txt) return txt;
      }
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) {
      const txt = cleanLabelNodeText(wrappingLabel);
      if (txt) return txt;
    }
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const td = el.closest("td");
    if (td) {
      let prev = td.previousElementSibling;
      while (prev) {
        if (prev.tagName === "TH") {
          const txt = cleanLabelNodeText(prev);
          if (txt) return txt;
          break;
        }
        prev = prev.previousElementSibling;
      }
    }

    const container = el.closest("fieldset, [role='group'], div");
    if (container && container !== document.body) {
      const lbl = container.querySelector("legend, label");
      if (lbl && !lbl.contains(el)) {
        const txt = cleanLabelNodeText(lbl);
        if (txt) return txt;
      }
    }

    return el.placeholder || el.name || el.id || "入力項目";
  }

  function resolveRadioGroupLabel(radios) {
    const first = radios[0];
    const group = first.closest('[role="radiogroup"], fieldset');
    if (group) {
      const aria = group.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const legend = group.querySelector("legend");
      if (legend) {
        const txt = cleanLabelNodeText(legend);
        if (txt) return txt;
      }
    }
    const td = first.closest("td");
    if (td && td.previousElementSibling && td.previousElementSibling.tagName === "TH") {
      const txt = cleanLabelNodeText(td.previousElementSibling);
      if (txt) return txt;
    }
    const parentBlock = first.parentElement?.closest("div, section");
    if (parentBlock) {
      const topLabel = parentBlock.querySelector(":scope > label");
      if (topLabel) {
        const txt = cleanLabelNodeText(topLabel);
        if (txt) return txt;
      }
    }
    return first.name || "選択項目";
  }

  function scanPageForm() {
    const controls = Array.from(document.querySelectorAll("input, select, textarea"));
    const fields = [];
    const handledRadioNames = new Set();
    let autoIdx = 0;

    for (const el of controls) {
      if (el.disabled || el.readOnly) continue;
      const tag = el.tagName.toLowerCase();
      const inputType = (el.getAttribute("type") || "text").toLowerCase();

      if (tag === "input" && ["hidden", "submit", "reset", "button", "image", "file", "password"].includes(inputType)) {
        continue;
      }
      if (!isElementVisible(el)) continue;

      if (tag === "input" && inputType === "radio") {
        const radioName = el.name;
        if (!radioName || handledRadioNames.has(radioName)) continue;
        handledRadioNames.add(radioName);

        const groupRadios = Array.from(
          document.querySelectorAll(`input[type="radio"][name="${CSS.escape(radioName)}"]`)
        ).filter((r) => !r.disabled);

        const options = groupRadios.map((r) => {
          const parentLbl = r.closest("label");
          const optText = parentLbl ? cleanLabelNodeText(parentLbl) : r.value;
          return { value: r.value, text: optText || r.value };
        });

        const checked = groupRadios.find((r) => r.checked);
        fields.push({
          fieldKey: radioName,
          label: resolveRadioGroupLabel(groupRadios),
          type: "radio",
          currentValue: checked ? checked.value : "",
          required: groupRadios.some((r) => r.required),
          placeholder: "",
          options,
        });
        continue;
      }

      let fieldKey = el.id || el.name || el.getAttribute("data-foundry-key");
      if (!fieldKey) {
        fieldKey = `foundry_field_${autoIdx++}`;
        el.setAttribute("data-foundry-key", fieldKey);
      }

      if (tag === "input" && inputType === "checkbox") {
        fields.push({
          fieldKey,
          label: resolveFieldLabel(el),
          type: "checkbox",
          currentValue: Boolean(el.checked),
          required: Boolean(el.required),
          placeholder: "",
          options: [],
        });
        continue;
      }

      if (tag === "select") {
        const options = Array.from(el.options)
          .filter((opt) => opt.value !== "")
          .map((opt) => ({
            value: opt.value,
            text: (opt.textContent || "").trim(),
          }));

        fields.push({
          fieldKey,
          label: resolveFieldLabel(el),
          type: "select",
          currentValue: el.value || "",
          required: Boolean(el.required),
          placeholder: "",
          options,
        });
        continue;
      }

      fields.push({
        fieldKey,
        label: resolveFieldLabel(el),
        type: tag === "textarea" ? "textarea" : inputType,
        currentValue: el.value || "",
        required: Boolean(el.required),
        placeholder: el.placeholder || "",
        options: [],
      });
    }

    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map((h) => (h.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 4)
      .join(" / ");

    return {
      pageContext: {
        title: document.title || "",
        url: window.location.href,
        heading: headings,
      },
      formFields: fields,
    };
  }

  function setNativeValue(element, value) {
    const proto =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function markHighlighted(target) {
    if (!target) return;
    target.classList.remove("foundry-autofilled");
    void target.offsetWidth;
    target.classList.add("foundry-autofilled");
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function applyFieldValues(fieldValues) {
    ensureHighlightStyle();
    const entries = Object.entries(fieldValues || {});
    const appliedDetails = [];

    for (const [key, rawVal] of entries) {
      if (rawVal === null || rawVal === undefined) continue;

      const radios = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${CSS.escape(key)}"]`)
      );
      if (radios.length > 0) {
        const targetRadio = radios.find((r) => r.value === String(rawVal));
        if (targetRadio) {
          targetRadio.checked = true;
          targetRadio.dispatchEvent(new Event("input", { bubbles: true }));
          targetRadio.dispatchEvent(new Event("change", { bubbles: true }));
          const wrap = targetRadio.closest("label") || targetRadio;
          markHighlighted(wrap);
          appliedDetails.push({
            fieldKey: key,
            label: resolveRadioGroupLabel(radios),
            displayValue: cleanLabelNodeText(targetRadio.closest("label")) || String(rawVal),
          });
          await sleep(45);
        }
        continue;
      }

      const el =
        document.getElementById(key) ||
        document.querySelector(`[name="${CSS.escape(key)}"]`) ||
        document.querySelector(`[data-foundry-key="${CSS.escape(key)}"]`);

      if (!el || el.disabled) continue;

      const tag = el.tagName.toLowerCase();
      const inputType = (el.getAttribute("type") || "text").toLowerCase();

      if (tag === "input" && inputType === "checkbox") {
        const boolVal = rawVal === true || rawVal === "true" || rawVal === 1 || rawVal === "1";
        el.checked = boolVal;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        markHighlighted(el.closest("label") || el);
        appliedDetails.push({
          fieldKey: key,
          label: resolveFieldLabel(el),
          displayValue: boolVal ? "ON (チェック済)" : "OFF",
        });
        await sleep(45);
        continue;
      }

      if (tag === "select") {
        const strVal = String(rawVal);
        const matchedOpt = Array.from(el.options).find(
          (o) => o.value === strVal || (o.textContent || "").trim() === strVal
        );
        if (matchedOpt) {
          setNativeValue(el, matchedOpt.value);
          markHighlighted(el);
          appliedDetails.push({
            fieldKey: key,
            label: resolveFieldLabel(el),
            displayValue: (matchedOpt.textContent || "").trim(),
          });
          await sleep(45);
        }
        continue;
      }

      setNativeValue(el, String(rawVal));
      markHighlighted(el);
      appliedDetails.push({
        fieldKey: key,
        label: resolveFieldLabel(el),
        displayValue: String(rawVal),
      });
      await sleep(45);
    }

    return {
      appliedCount: appliedDetails.length,
      totalRequested: entries.length,
      appliedDetails,
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SCAN_FORM") {
      try {
        sendResponse({ ok: true, ...scanPageForm() });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return false;
    }

    if (msg?.type === "APPLY_VALUES") {
      applyFieldValues(msg.fieldValues)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    return false;
  });
})();
