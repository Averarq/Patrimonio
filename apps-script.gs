/**
 * PATRIMONIO — lector de correos
 *
 * Corre en tu propia cuenta de Google. Lee los avisos del Banco de Chile
 * y de Fintual, los interpreta y los entrega como JSON a la app.
 *
 * ESTE ARCHIVO NO VA AL REPOSITORIO. Contiene la clave que protege
 * la dirección pública del script. Vive solo en tu computador y en
 * tu proyecto de Apps Script.
 *
 * Si alguna vez esta clave queda expuesta, cámbiala aquí, vuelve a
 * implementar el script y actualízala en la app.
 */

const CLAVE = "vertiente-tabular-adobe-cordillera-9068";
const REMITENTES = "from:(enviodigital@bancochile.cl OR serviciodetransferencias@bancochile.cl OR mensajeria@santander.cl OR hola@fintual.com)";
const MAX_HILOS = 150;

/* Tus cuentas, por los últimos cuatro dígitos. Sirve para saber a qué cuenta
   entró o salió una transferencia, y para distinguir un traspaso propio de
   una transferencia a un tercero. */
const MIS_CUENTAS = { "7705": "cuenta", "7950": "santander", "1315": "estado" };

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.k !== CLAVE) return json({ error: "clave incorrecta" });

  const dias = Math.max(1, Math.min(60, parseInt(p.d || "7", 10) || 7));
  let mov = [];

  try {
    const hilos = GmailApp.search(REMITENTES + " newer_than:" + dias + "d", 0, MAX_HILOS);
    GmailApp.getMessagesForThreads(hilos).forEach(function (hilo) {
      hilo.forEach(function (msg) {
        // La fecha del correo sirve de hora cuando el aviso solo trae el día.
        mov = mov.concat(extraer(msg.getPlainBody(), msg.getDate()));
      });
    });
  } catch (err) {
    return json({ error: "no pude leer el correo: " + err.message });
  }

  // Quita repetidos y deja los más recientes primero
  const vistos = {};
  mov = mov.filter(function (m) {
    // La cuenta y el tipo entran en la clave: un traspaso propio son dos
    // movimientos iguales en cuentas distintas.
    const k = m.f + "|" + m.d + "|" + m.m + "|" + (m.tipo || "") + "|" + (m.k || "cargo");
    if (vistos[k]) return false;
    vistos[k] = true;
    return true;
  }).sort(function (a, b) { return a.f < b.f ? 1 : -1; }).slice(0, 200);

  return json({ mov: mov, generado: new Date().toISOString(), dias: dias });
}

/** Interpreta el texto de un aviso y devuelve los movimientos que encuentre.
 *  fechaMsg: fecha de llegada del correo, usada como hora cuando el aviso
 *  solo indica el día (los de Santander no traen hora). */
function extraer(txt, fechaMsg) {
  const out = [];
  const re = /compra por (US ?\$|\$)\s?([\d.,]+)\s+con\s+(cargo a Cuenta|Tarjeta de Cr[ée]dito)\s+\*{0,4}(\d{4})\s+en\s+(.+?)\s+el\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/gi;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const esUsd = /US/i.test(m[1]);
    const esTc = /cr[ée]dito/i.test(m[3]);
    out.push({
      f: m[8] + "-" + m[7] + "-" + m[6] + "T" + m[9],
      d: m[5].trim().toUpperCase().slice(0, 40),
      m: numCL(m[2]),
      mon: esUsd ? "USD" : "CLP",
      tipo: esTc ? "credito" : "cuenta"
    });
  }

  // Giros en cajero: el aviso no menciona comercio, necesita su propio patrón.
  var reGiro = /giro en ([A-Za-zÁÉÍÓÚáéíóúñÑ]+)\s+por\s+(US ?\$|\$)\s?([\d.,]+)\s+con\s+cargo a Cuenta\s+\*{0,4}(\d{4})\s+el\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2})/gi;
  while ((m = reGiro.exec(txt)) !== null) {
    // Sacar plata del cajero no es gastarla: sale de la cuenta y entra a la billetera.
    var fg = m[7] + "-" + m[6] + "-" + m[5] + "T" + m[8];
    var dg = ("GIRO EN " + m[1]).toUpperCase().slice(0, 40);
    var mg = numCL(m[3]);
    var og = /US/i.test(m[2]) ? "USD" : "CLP";
    out.push({ f: fg, d: dg, m: mg, mon: og, tipo: "cuenta",   k: "cargo", p: 1 });
    out.push({ f: fg, d: dg, m: mg, mon: og, tipo: "efectivo", k: "abono", p: 1 });
  }

  // Transferencias (serviciodetransferencias@bancochile.cl).
  // Las recibidas son abono, las enviadas cargo. La fecha viene en palabras.
  txt.split(/Comprobante de/i).forEach(function (b) {
    if (!/transferencia/i.test(b)) return;
    var f = fechaLarga(b);
    var mm = /Monto\s*\$\s?([\d.,]+)/i.exec(b);
    if (!f || !mm) return;
    var monto = numCL(mm[1]);
    if (monto <= 0) return;

    if (/ha efectuado una transferencia\s+de fondos a tu cuenta/i.test(b)) {
      var q = /cliente\s+([\s\S]+?)\s+ha efectuado/i.exec(b);
      var bco = /Banco\s+(Banco[^\n]*|BancoEstado[^\n]*)/i.exec(b);
      out.push({
        f: f,
        d: ("TRANSF DE " + (q ? q[1] : "TERCERO")).replace(/\s+/g, " ").toUpperCase().slice(0, 40),
        m: monto, mon: "CLP",
        tipo: (bco && /santander/i.test(bco[1])) ? "santander" : "cuenta",
        k: "abono"
      });
    } else if (/has realizado una Transferencia a terceros/i.test(b)) {
      var qd = /Nombre y Apellido\s+([^\n]+)/i.exec(b);
      out.push({
        f: f,
        d: ("TRANSF A " + (qd ? qd[1] : "TERCERO")).replace(/\s+/g, " ").toUpperCase().slice(0, 40),
        m: monto, mon: "CLP", tipo: "cuenta", k: "cargo"
      });
    }
  });

  // Santander avisa cuando quien transfiere es cliente de ellos. Dos formatos,
  // y ninguno trae hora: se usa la del correo.
  var hh = "23:59";
  if (fechaMsg) {
    hh = ("0" + fechaMsg.getHours()).slice(-2) + ":" + ("0" + fechaMsg.getMinutes()).slice(-2);
  }
  var sanA = /nuestro cliente\s+([\s\S]+?)\s+realiz[oó] una transferencia a tu cuenta/i;
  var sanB = /instruido por nuestro cliente\s+([\s\S]+?),\s*le informamos/i;
  txt.split(/Aviso de Transferencia de Fondos|Comprobante\s+Transferencia de fondos/i).forEach(function (b) {
    // Comprobante de una transferencia que hiciste desde Santander: trae origen y
    // destino. Si ambas cuentas son tuyas es un traspaso y genera los dos lados.
    var env = /Te enviamos el detalle de la transferencia realizada el (\d{2})\/(\d{2})\/(\d{4})/i.exec(b);
    if (env) {
      var me = /Monto transferido[\s\S]{0,160}?\$\s?([\d.,]+)/i.exec(b);
      if (!me) return;
      var mo = numCL(me[1]);
      if (mo <= 0) return;
      var fe = env[3] + "-" + env[2] + "-" + env[1] + "T" + hh;
      var or = /Datos de origen[\s\S]{0,400}?N[ºo°]?\s*de cuenta\s+([\d][\d\-]{6,})/i.exec(b);
      var de = /Datos de destino[\s\S]{0,500}?N[ºo°]?\s*de cuenta\s+([\d][\d\-]{6,})/i.exec(b);
      var nom = /Datos de destino[\s\S]{0,200}?Nombre\s+([^\n]+)/i.exec(b);
      var cOr = miCuenta(or ? or[1] : "") || "santander";
      var cDe = miCuenta(de ? de[1] : "");
      var propio = !!cDe && cDe !== cOr;
      out.push({
        f: fe,
        d: (propio ? "TRASPASO ENTRE MIS CUENTAS" : "TRANSF A " + (nom ? nom[1] : "TERCERO"))
          .replace(/\s+/g, " ").toUpperCase().slice(0, 40),
        m: mo, mon: "CLP", tipo: cOr, k: "cargo", p: propio ? 1 : 0
      });
      if (propio) out.push({
        f: fe, d: "TRASPASO ENTRE MIS CUENTAS", m: mo, mon: "CLP", tipo: cDe, k: "abono", p: 1
      });
      return;
    }

    var esA = sanA.test(b), esB = sanB.test(b);
    if (!esA && !esB) return;
    var mm = /Monto transferido[\s\S]{0,160}?\$\s?([\d.,]+)/i.exec(b);
    if (!mm) return;
    var monto = numCL(mm[1]);
    if (monto <= 0) return;

    var s, f = null;
    if ((s = /con fecha[:\s]+(\d{2})\/(\d{2})\/(\d{4})/i.exec(b))) f = s[3] + "-" + s[2] + "-" + s[1] + "T" + hh;
    else if ((s = /Fecha:\s*(\d{2})-(\d{2})-(\d{4})/i.exec(b))) f = s[3] + "-" + s[2] + "-" + s[1] + "T" + hh;
    if (!f) return;

    var quien = (esA ? sanA.exec(b) : sanB.exec(b))[1];
    var bco = "", nro = "";
    if ((s = /hacia su cuenta del banco\s+([\s\S]*?)\s+nro\.?\s*([\d-]+)/i.exec(b))) { bco = s[1]; nro = s[2]; }
    else {
      var bb = /Banco\s+((?:Banco|BANCO)[^\n]*)/i.exec(b);
      var nn = /N[ºo°]?\s*de cuenta\s+([\d][\d\-]{6,})/i.exec(b);
      bco = bb ? bb[1] : ""; nro = nn ? nn[1] : "";
    }
    var destino = miCuenta(nro);
    if (!destino) destino = /santander/i.test(bco) ? "santander"
                          : /estado/i.test(bco)    ? "estado" : "cuenta";

    out.push({
      f: f,
      d: ("TRANSF DE " + quien).replace(/\s+/g, " ").toUpperCase().slice(0, 40),
      m: monto, mon: "CLP",
      tipo: destino,
      k: "abono"
    });
  });

  return out;
}

/** Devuelve tu cuenta según los últimos cuatro dígitos, o null si es de un tercero. */
function miCuenta(numTxt) {
  var dig = String(numTxt || "").replace(/\D/g, "");
  if (dig.length < 4) return null;
  return MIS_CUENTAS[dig.slice(-4)] || null;
}

/** Fechas en palabras: "viernes 24 de julio de 2026 16:18" */
var MESES_N = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10",
  noviembre: "11", diciembre: "12"
};
function fechaLarga(t) {
  var f = /Fecha y Hora:?\s*(?:[a-záéíóúA-ZÁÉÍÓÚ]+\s+)?(\d{1,2})\s+de\s+([a-záéíóúA-ZÁÉÍÓÚ]+)\s+de\s+(\d{4})[\s,]*(\d{1,2}):(\d{2})/i.exec(t);
  if (!f) return null;
  var mes = MESES_N[f[2].toLowerCase()];
  if (!mes) return null;
  return f[3] + "-" + mes + "-" + ("0" + f[1]).slice(-2) + "T" + ("0" + f[4]).slice(-2) + ":" + f[5];
}

/** Convierte "16.948" a 16948 y "19,15" a 19.15 */
function numCL(s) {
  s = String(s).replace(/[^\d.,-]/g, "");
  if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
  else if (/\.\d{3}(\D|$)/.test(s + " ")) s = s.replace(/\./g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function json(o) {
  return ContentService
    .createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Para probar desde el editor: Ejecutar > prueba, y mira el registro. */
function prueba() {
  const r = doGet({ parameter: { k: CLAVE, d: 7 } });
  Logger.log(r.getContent());
}
