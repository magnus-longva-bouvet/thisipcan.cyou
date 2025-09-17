/*
 * Copyright (c) 2022 Christian Wittenberg
 *
 * thisipcan.cyou gnome extension is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by the
 * Free Software Foundation; either version 3 of the License, or (at your
 * option) any later version.
 *
 * thisipcan.cyou gnome extension is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Gnome Documents; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA  02110-1301  USA
 *
 * Author:
 * Christian Wittenberg <gnome@ipcan.cyou>
 *
 */

const { St, Clutter, Gio, Soup, GLib, GObject } = imports.gi;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const { IpLookup } = Me.imports.ip_lookup;
let ipLookup = null;
let lastLookup = { ip: null, geo: null, asn: null }; // cached result
let refreshInFlight = false;
let refreshGen = 0;

const Mainloop = imports.mainloop;
const Main = imports.ui.main;
const Util = imports.misc.util;
const MessageTray = imports.ui.messageTray;
const PopupMenu = imports.ui.popupMenu;
const PanelMenu = imports.ui.panelMenu;

notification_msg_sources = new Set(); // stores IDs of previously displayed notifications (for providing a handle to destruction)

const thisExtensionDir = Me.path;

const extIpv4Service = "https://ipv4.icanhazip.com";
const extIpService = "https://freeipapi.com/api/json";
const extIpServiceASN = "https://thisipcan.cyou/";
const extIpServiceStaticMap = "https://staticmap.thisipcan.cyou/";
const extCountryFlagService = "https://thisipcan.cyou/flag-<countrycode>";

// Enable verbose logging for diagnostics (set to false to silence)
let debug = true;
let panelButtonText = null;
let panelIcon = null;
let sourceLoopID = null;
let messageTray = null;

let currentIP = ""; // stores previously detected external ip
let disabled = false; // stop processing if extension is disabled
let elapsed = 0; // time elapsed before next external ip check
let timeout = 60 * 10; // be friendly, refresh every 10 mins.
let minTimeBetweenChecks = 4; //in seconds, to avoid network event induced IP re-checks occur too frequent

// Network event monitoring
const GnomeSession = imports.misc.gnomeSession;
let network_monitor = null;
let presence = null;
let presence_connection = null;
let network_monitor_connection = null;

let networkEventRefreshTimeout = 4;
let networkEventRefreshLoopID = null;
let netEventSuppressNotifyUntil = 0; // ms since epoch
let netEventSeenAt = 0;

let isIdle = false;

let menu = null;
let btn = null;
let panelButton = null;
let popup_icon = null;

let Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    update(ip, country, isp = null) {
      const cc =
        typeof country === "string" && country.length
          ? country.toLowerCase()
          : null;
      const flagURL = cc ? getCachedFlag(cc) : thisExtensionDir + "/img/ip.svg"; // fallback icon
      btn.set_style('background-image: url("' + flagURL + '");');
      btn.set_label(ip || "");
      const tt = isp ? "ISP: " + isp : null;
      try {
        this.set_tooltip_text(tt);
      } catch (_) {}
      try {
        btn.set_tooltip_text(tt);
      } catch (_) {}
    }

    _init(ip = "", country = "gb", isp = null) {
      var that = this;
      super._init(0.0, _(Me.metadata["name"]));

      btn = new St.Button();
      btn.set_style_class_name("notifyIcon");

      this.update(ip, country, isp);

      this.connect("button-press-event", this._onButtonClicked);
      btn.connect("button-press-event", this._onButtonClicked);

      this.add_child(btn);
    }

    _onButtonClicked(obj, e) {
      let container = obj;
      if (obj.menu == null) {
        //left button
        obj = obj.get_parent();
      }

      //re-add to reflect change in separatormenuitem
      obj.menu.removeAll();

      obj.menu.addMenuItem(
        new PopupMenu.PopupSeparatorMenuItem(_("Click to copy to clipboard"))
      );

      let copyTextFunction = function (item, event) {
        St.Clipboard.get_default().set_text(
          St.ClipboardType.CLIPBOARD,
          item.label.text
        );
        return Clutter.EVENT_PROPAGATE;
      };

      let copyBtn = new PopupMenu.PopupImageMenuItem(
        _(locationIP.ipAddress),
        getIcon("ip_ed.svg"),
        { style_class: "ipMenuItem" }
      );
      copyBtn.connect("activate", copyTextFunction);
      obj.menu.addMenuItem(copyBtn);

      // ISP row (from cached locationIP)
      if (locationIP && locationIP.isp) {
        let ispBtn = new PopupMenu.PopupImageMenuItem(
          _(locationIP.isp),
          getIcon("company.svg"),
          {}
        );
        ispBtn.connect("activate", copyTextFunction);
        obj.menu.addMenuItem(ispBtn);
      }

      // Show a temporary "Loading…" row, then update asynchronously
      let loading = new PopupMenu.PopupMenuItem(_("Loading network info…"), {
        reactive: false,
      });
      obj.menu.addMenuItem(loading);

      httpRequestAsync(extIpServiceASN, (err, txt) => {
        let asn = null;
        if (!err && txt) {
          try {
            asn = JSON.parse(txt);
          } catch (_) {}
        }
        // Update the menu on the main loop once we have data
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          // Rebuild the menu section after "Loading…"
          if (asn) {
            if ("hostname" in asn) {
              let hostBtn = new PopupMenu.PopupImageMenuItem(
                _(asn.hostname),
                getIcon("host.svg"),
                {}
              );
              hostBtn.connect("activate", copyTextFunction);
              obj.menu.addMenuItem(hostBtn);
            }
            if ("org" in asn) {
              let orgBtn = new PopupMenu.PopupImageMenuItem(
                _(asn.org),
                getIcon("company.svg"),
                {}
              );
              orgBtn.connect("activate", copyTextFunction);
              obj.menu.addMenuItem(orgBtn);
            }
            if ("timezone" in asn) {
              let tzBtn = new PopupMenu.PopupImageMenuItem(
                _(asn.timezone),
                getIcon("timezone.svg"),
                {}
              );
              tzBtn.connect("activate", copyTextFunction);
              obj.menu.addMenuItem(tzBtn);
            }
          } else {
            loading.label.set_text(_("Failed to load network info"));
          }
          // Remove the loading row
          try {
            loading.destroy();
          } catch (_) {}
          return GLib.SOURCE_REMOVE;
        });
      });

      const cc =
        locationIP &&
        typeof locationIP.countryCode === "string" &&
        locationIP.countryCode
          ? locationIP.countryCode
          : null;
      const flagFile = cc
        ? getCachedFlag(cc)
        : thisExtensionDir + "/img/ip.svg";
      const flagIcon = getIcon(flagFile, true);
      const cName =
        locationIP && locationIP.countryName
          ? locationIP.countryName
          : "Unknown";
      const city =
        locationIP && locationIP.cityName ? ", " + locationIP.cityName : "";
      const ccTxt = cc ? " (" + cc + ")" : "";
      let countryBtn = new PopupMenu.PopupImageMenuItem(
        _(cName + ccTxt + city),
        flagIcon,
        {}
      );
      countryBtn.connect("activate", copyTextFunction);
      obj.menu.addMenuItem(countryBtn);

      if (
        typeof locationIP.latitude === "number" &&
        typeof locationIP.longitude === "number"
      ) {
        const latKey = normCoord(locationIP.latitude, 5);
        const lonKey = normCoord(locationIP.longitude, 5);

        const mapItem = new PopupMenu.PopupMenuItem(_(""), {
          style_class: "mapMenuItem",
        });
        const mapPath = getCachedMap(latKey, lonKey);

        if (mapPath) {
          mapItem.set_style("background-image: url('file://" + mapPath + "')");
        } else {
          const text = _("Coordinates: ") + latKey + ", " + lonKey;
          mapItem.label.set_text(text); // PopupMenuItem doesn't have set_label()
        }

        const mapsUrl =
          "https://maps.google.com/maps?q=" + latKey + "," + lonKey;
        mapItem.connect("activate", function () {
          GLib.spawn_command_line_async('xdg-open "' + mapsUrl + '"');
          return Clutter.EVENT_PROPAGATE;
        });

        obj.menu.addMenuItem(mapItem);
      }

      obj.menu.toggle();
    }
  }
);

// In case of GNOME event
function _onStatusChanged(presence, status) {
  let backFromSleep = false;

  lg("Gnome status changed");

  if (status == GnomeSession.PresenceStatus.IDLE) {
    isIdle = true;

    lg("Disabling network monitor");
    networkMonitorDisable();
  } else {
    if (isIdle) {
      backFromSleep = true;
    }

    isIdle = false;

    lg("Enabling network monitor");
    networkMonitorEnable();
  }

  if (backFromSleep) {
    lg("Device unlocked/awoken");
    if (sourceLoopID) {
      GLib.Source.remove(sourceLoopID);
      sourceLoopID = null;
    }

    timer();
  }
}

// In case of a network event, inquire external IP.
function _onNetworkStatusChanged(maybeMonitor, maybeAvailable) {
  try {
    if (isIdle) return;

    const available =
      typeof maybeAvailable === "boolean"
        ? maybeAvailable
        : maybeMonitor && maybeMonitor.get_network_available
        ? maybeMonitor.get_network_available()
        : false;

    lg(`Network changed: available=${available}`);

    if (networkEventRefreshLoopID) {
      try {
        GLib.Source.remove(networkEventRefreshLoopID);
      } catch (_) {}
      networkEventRefreshLoopID = null;
    }

    if (!available) return;

    // Debounce and set a 15s “no notifications” window
    netEventSeenAt = Date.now();
    netEventSuppressNotifyUntil = netEventSeenAt + 15000;

    networkEventRefreshLoopID = Mainloop.timeout_add_seconds(
      networkEventRefreshTimeout,
      () => {
        networkEventRefreshLoopID = null;
        refreshIPAsync();
        return GLib.SOURCE_REMOVE;
      }
    );
  } catch (e) {
    warn("_onNetworkStatusChanged threw: " + e);
  }
}

// New async refresh that never blocks the shell
async function refreshIPAsync() {
  if (isDisabled()) {
    lg("refreshIPAsync(): disabled");
    return true;
  }

  const now = Date.now();
  if (now - lastCheck <= minTimeBetweenChecks * 1000) {
    lg("refreshIPAsync(): throttled");
    return true;
  }
  if (refreshInFlight) {
    lg("refreshIPAsync(): another refresh in flight");
    return true;
  }
  refreshInFlight = true;
  lastCheck = now;
  const myGen = ++refreshGen;

  try {
    const payload = await ipLookup.getAllAsync({ timeoutSec: 6 });
    if (isDisabled() || myGen !== refreshGen) return true;

    const { ip, geo, asn } = payload || {};
    if (!ip || !geo) {
      lg("refreshIPAsync(): empty result");
      return true;
    }

    locationIP = {
      ipAddress: ip,
      countryCode: geo.countryCode,
      countryName: geo.countryName,
      cityName: geo.cityName,
      latitude: geo.latitude,
      longitude: geo.longitude,
      isp: geo.isp,
    };
    lastLookup = { ip, geo, asn };

    if (currentIP && currentIP !== ip) {
      const now = Date.now();
      if (now >= netEventSuppressNotifyUntil) {
        try {
          notify("External IP Address", `Has been changed to ${ip}`);
        } catch (e) {
          warn("notify failed: " + e);
        }
      } else {
        lg(
          `IP changed (${currentIP} -> ${ip}) but notifications suppressed for ${
            netEventSuppressNotifyUntil - now
          }ms`
        );
      }
    }

    currentIP = ip;

    if (panelButton) {
      try {
        panelButton.update(
          currentIP,
          locationIP.countryCode,
          locationIP.isp || null
        );
      } catch (e) {
        warn("panelButton.update failed: " + e);
      }
    }
  } catch (e) {
    warn("refreshIPAsync(): " + e);
  } finally {
    refreshInFlight = false;
  }
  return true;
}

function lg(s) {
  if (!debug) return;
  try {
    log("===" + Me.metadata["gettext-domain"] + "===>" + s);
  } catch (_) {}
}

function warn(s) {
  try {
    log("*** " + Me.metadata["gettext-domain"] + " WARNING: " + s);
  } catch (_) {}
}

function isDisabled() {
  return disabled === true;
}

function safeActorDesc(a) {
  if (!a) return "<null>";
  try {
    return a.toString();
  } catch (_) {
    return "<actor?>";
  }
}

// returns raw HTTP response
function httpRequest(url, type = "GET") {
  let soupSyncSession = new Soup.SessionSync();
  let message = Soup.Message.new(type, url);

  message.request_headers.set_content_type("application/json", null);
  let responseCode = soupSyncSession.send_message(message);
  let out;
  if (responseCode == 200) {
    try {
      out = message["response-body"].data;
    } catch (error) {
      lg(error);
    }
  }
  return out;
}

// Create GNOME Notification
// inspired by: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/a3c84ca7463ed92b5be6f013a12bce927223f7c5/js/ui/main.js#L509
// modified:
// - added icon specifics.
// - added global messagetray destination.
// - bugfix: added fix for missing icon specification in Source constructor, this caused occassional crashes to Logout
// - moved popup_icon to a once-initialized variable to prevent unnecessary reloading.
function notify(title, msg) {
  if (isDisabled()) {
    lg("notify() skipped; extension disabled");
    return;
  }

  let source;
  try {
    // DO NOT pass a filesystem path as the icon-name argument
    source = new MessageTray.Source(title);
  } catch (e) {
    warn("Failed to create MessageTray.Source: " + e);
    return;
  }

  notification_msg_sources.add(source);
  try {
    Main.messageTray.add(source);
  } catch (e) {
    warn("Failed to add notification source: " + e);
    return;
  }

  let notification;
  try {
    notification = new MessageTray.Notification(source, title, msg, {
      bannerMarkup: true,
      gicon: popup_icon, // set by getIcon("ip.svg")
    });
  } catch (e) {
    warn("Failed to build notification: " + e);
    return;
  }

  notification.connect("destroy", (n) => {
    notification_msg_sources.delete(n.source);
  });

  try {
    source.showNotification(notification);
  } catch (e) {
    warn("Failed to show notification: " + e);
  }
}

function getFlagUrl(countryCode) {
  if (!countryCode || typeof countryCode !== "string") return null;
  return extCountryFlagService.replace(
    "<countrycode>",
    countryCode.toLowerCase()
  );
}

// gets external IP and updates label in toolbar
// if changed, show GNOME notification
let lastCheck = 0;
let locationIP = null;

// wait until time elapsed, to be friendly to external ip url
function timer() {
  if (!disabled && !isIdle) {
    sourceLoopID = Mainloop.timeout_add_seconds(timeout, function () {
      ipPromise()
        .then((result) => {
          lg("reinvoke");

          //reinvoke itself
          timer();
        })
        .catch((e) => {
          lg("Error occured in ipPromise");
          timer();
        });
    });
  }
}

// Run polling procedure completely async
function ipPromise() {
  return new Promise(async (resolve) => {
    try {
      await refreshIPAsync(); // <-- await the async refresh
      resolve("success");
    } catch (e) {
      warn("ipPromise(): refreshIPAsync threw: " + e);
      resolve("handled-exception"); // don't break the timer loop
    }
  });
}

function init() {}

function normCoord(val, decimals = 5) {
  // force number → fixed decimals string
  const n = Number(val);
  if (!isFinite(n)) return null;
  return n.toFixed(decimals); // e.g. "59.91275"
}

// Download application specific flags and cache locally
function getCachedMap(lat, lon) {
  const latKey = normCoord(lat, 5);
  const lonKey = normCoord(lon, 5);
  if (latKey === null || lonKey === null) return null;

  const dir = thisExtensionDir + "/maps/";
  const mapFile = dir + latKey + "_" + lonKey + ".svg";

  // Ensure directory exists
  const dirFile = Gio.File.new_for_path(dir);
  if (!dirFile.query_exists(null)) {
    try {
      dirFile.make_directory_with_parents(null);
    } catch (_) {}
  }

  const fileObj = Gio.File.new_for_path(mapFile);
  if (!fileObj.query_exists(null)) {
    // Fetch using the same normalized coords (keeps filename + server request consistent)
    const url =
      extIpServiceStaticMap +
      "?lat=" +
      latKey +
      "&lon=" +
      lonKey +
      "&f=SVG&marker=12&w=250&h=150";

    const session = new Soup.SessionSync();
    const msg = Soup.Message.new("GET", url);
    const code = session.send_message(msg);
    if (code === 200) {
      try {
        const bytes = msg["response-body"].flatten().get_data();
        fileObj.replace_contents(
          bytes,
          null,
          false,
          Gio.FileCreateFlags.REPLACE_DESTINATION,
          null
        );
      } catch (e) {
        lg("Error saving cached map: " + e);
        return null;
      }
    } else {
      // download failed
      return null;
    }
  }

  return fileObj.query_exists(null) ? mapFile : null;
}

// Download application specific flags and cache locally
function getCachedFlag(country) {
  if (!country || typeof country !== "string")
    return thisExtensionDir + "/img/ip.svg";
  country = country.toLowerCase();

  const iconFileDestination = thisExtensionDir + "/flags/" + country + ".svg";
  const file = Gio.File.new_for_path(iconFileDestination);
  if (file.query_exists(null)) return iconFileDestination;

  // Return fallback immediately; fetch in background and update later
  const url = getFlagUrl(country);
  if (url) {
    try {
      const session = new Soup.Session();
      const msg = Soup.Message.new("GET", url);
      session.queue_message(msg, (_s, m) => {
        if (isDisabled()) return;
        if (m && m.status_code === 200) {
          try {
            const bytes = m.response_body.flatten().get_data();
            file.replace_contents(
              bytes,
              null,
              false,
              Gio.FileCreateFlags.REPLACE_DESTINATION,
              null
            );
            // Update icon after download
            if (panelButton && currentIP && locationIP) {
              GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                try {
                  panelButton.update(
                    currentIP,
                    country,
                    locationIP.isp || null
                  );
                } catch (_) {}
                return GLib.SOURCE_REMOVE;
              });
            }
          } catch (_) {}
        }
      });
    } catch (_) {}
  }
  return thisExtensionDir + "/img/ip.svg"; // fallback immediately
}

// Returns SVG as gicon
function getIcon(fileName, noPrefix = false) {
  let prefix = "";
  if (noPrefix == false) {
    prefix = thisExtensionDir + "/img/";
  }

  let file = Gio.File.new_for_path(prefix + fileName);
  return (icon = new Gio.FileIcon({
    file,
  }));
}

function enable() {
  lg("enable(): starting");
  disabled = false;

  if (!ipLookup) ipLookup = new IpLookup();

  popup_icon = getIcon("ip.svg");

  if (panelButton == null) {
    lg("enable(): creating Indicator");
    panelButton = new Indicator();
  }

  try {
    const uuid = Me.metadata.uuid;
    Main.panel.addToStatusArea(uuid, panelButton, 0, "right");
    lg("enable(): panel button added");
  } catch (e) {
    warn("enable(): failed to add panel button: " + e);
  }

  presence = new GnomeSession.Presence((proxy, error) => {
    _onStatusChanged(proxy.status);
  });
  presence_connection = presence.connectSignal(
    "StatusChanged",
    (proxy, senderName, [status]) => {
      _onStatusChanged(status);
    }
  );
  lg("enable(): presence connected id=" + presence_connection);

  networkMonitorEnable();

  refreshIPAsync(); // <--
  timer();
}

function networkMonitorEnable() {
  if (network_monitor) return;
  network_monitor = Gio.network_monitor_get_default();
  try {
    network_monitor_connection = network_monitor.connect(
      "network-changed",
      _onNetworkStatusChanged   // the new 2-arg handler
    );
    lg("networkMonitorEnable(): connected id=" + network_monitor_connection);
  } catch (e) {
    warn("networkMonitorEnable(): failed: " + e);
  }
}


function networkMonitorDisable() {
  if (network_monitor && network_monitor_connection) {
    try {
      network_monitor.disconnect(network_monitor_connection);
    } catch (e) {
      warn("networkMonitorDisable(): disconnect failed: " + e);
    }
  }
  network_monitor = null;
  network_monitor_connection = null;
  if (networkEventRefreshLoopID) {
    GLib.Source.remove(networkEventRefreshLoopID);
    networkEventRefreshLoopID = null;
  }
  lg("networkMonitorDisable(): done");
}

function disable() {
  lg("disable(): starting cleanup");
  disabled = true;

  for (let source of notification_msg_sources) {
    try {
      source.destroy();
    } catch (_) {}
  }
  notification_msg_sources.clear();

  popup_icon = null;
  messageTray = null;

  if (panelButton) {
    try {
      panelButton.destroy(); // destroy is enough; remove_child not required
      lg("disable(): panelButton destroyed");
    } catch (e) {
      warn("disable(): panelButton destroy failed: " + e);
    }
  }
  panelButton = null;
  panelButtonText = null;
  btn = null;
  locationIP = null;

  if (presence && presence_connection) {
    try {
      presence.disconnectSignal(presence_connection);
    } catch (e) {
      warn("disable(): presence disconnect failed: " + e);
    }
  }
  presence = null;
  presence_connection = null;

  networkMonitorDisable();

  if (sourceLoopID) {
    GLib.Source.remove(sourceLoopID);
    sourceLoopID = null;
  }
  lg("disable(): finished");
}

function httpRequestAsync(url, cb) {
  const session = new Soup.Session(); // async
  const msg = Soup.Message.new("GET", url);
  session.queue_message(msg, (_sess, m) => {
    if (isDisabled()) {
      lg("httpRequestAsync(): callback skipped; disabled");
      return;
    }
    try {
      if (m.status_code === 200) cb(null, m.response_body.data);
      else cb(new Error(`HTTP ${m.status_code}`));
    } catch (e) {
      warn("httpRequestAsync(): user callback threw: " + e);
    }
  });
}
