(function () {
  const loginForm = document.getElementById("loginForm");
  const loginStatus = document.getElementById("loginStatus");
  const loginButton = document.getElementById("loginButton");
  const emailInput = document.getElementById("bossEmail");
  const passwordInput = document.getElementById("bossPassword");

  const dashboard = document.getElementById("dashboard");
  const ownerListEl = document.getElementById("ownerList");
  const refreshButton = document.getElementById("refreshOwners");
  const totalOwnersEl = document.getElementById("totalOwners");
  const premiumOwnersEl = document.getElementById("premiumOwners");
  const freeOwnersEl = document.getElementById("freeOwners");

  if (!window.firebaseConfig) {
    loginStatus.textContent =
      "Missing Firebase config. Update public/firebase-config.js.";
    loginButton.disabled = true;
    return;
  }

  const app =
    firebase.apps && firebase.apps.length
      ? firebase.app()
      : firebase.initializeApp(window.firebaseConfig);
  const auth = firebase.auth(app);
  const db = firebase.firestore(app);
  const functions = firebase.functions(app);

  let unsubscribeOwners = null;
  let allOwners = [];

  const BOSS_ADMIN_EMAIL = "boss@foodeepicker.com";

  const setLoginStatus = (text, tone = "info") => {
    loginStatus.textContent = text;
    loginStatus.style.color =
      tone === "error" ? "var(--accent)" : "var(--muted)";
  };

  const toggleDashboard = (show) => {
    dashboard.style.display = show ? "flex" : "none";
    if (!show) {
      allOwners = [];
      updateOwnerList();
    }
  };

  const isBossAdmin = (email) => {
    if (!email) return false;
    const normalized = email.toLowerCase().trim();
    return normalized === BOSS_ADMIN_EMAIL || normalized.endsWith("@foodeepicker.com");
  };

  const createOwnerCard = (ownerDoc) => {
    const ownerId = ownerDoc.id;
    const data = ownerDoc.data();
    const plan = data.subscriptionPlan || "free";
    const isActive = data.active !== false;
    const email = data.email || "No email";
    const userCount = data.userCount || 0;
    const regularCount = data.regularCount || 0;

    const card = document.createElement("div");
    card.className = "list-item";

    const info = document.createElement("div");
    info.className = "owner-info";

    const title = document.createElement("strong");
    title.textContent = ownerId;
    info.appendChild(title);

    const emailEl = document.createElement("small");
    emailEl.textContent = email;
    info.appendChild(emailEl);

    const statsEl = document.createElement("small");
    statsEl.textContent = `${userCount} active, ${regularCount} regular`;
    info.appendChild(statsEl);

    card.appendChild(info);

    const badge = document.createElement("span");
    badge.className = "badge";
    if (!isActive) {
      badge.classList.add("inactive");
      badge.textContent = "Inactive";
    } else if (plan === "premium") {
      badge.classList.add("premium");
      badge.textContent = "Premium";
    } else {
      badge.classList.add("free");
      badge.textContent = "Free";
    }
    card.appendChild(badge);

    const actions = document.createElement("div");
    actions.className = "actions";

    const planSelect = document.createElement("select");
    planSelect.value = plan;
    planSelect.innerHTML = `
      <option value="free">Free</option>
      <option value="premium">Premium</option>
    `;
    planSelect.addEventListener("change", async () => {
      const newPlan = planSelect.value;
      if (newPlan === plan) return;
      try {
        const updateOwnerSubscription = functions.httpsCallable(
          "updateOwnerSubscription"
        );
        await updateOwnerSubscription({
          ownerId,
          subscriptionPlan: newPlan,
        });
        setLoginStatus(
          `Updated ${ownerId} to ${newPlan} plan.`,
          "info"
        );
      } catch (error) {
        console.error("Update subscription failed", error);
        setLoginStatus(
          error.message || "Could not update subscription.",
          "error"
        );
        planSelect.value = plan;
      }
    });
    actions.appendChild(planSelect);

    const deactivateBtn = document.createElement("button");
    deactivateBtn.className = "secondary";
    deactivateBtn.textContent = isActive ? "Deactivate" : "Activate";
    deactivateBtn.addEventListener("click", async () => {
      if (!confirm(`Are you sure you want to ${isActive ? "deactivate" : "activate"} ${ownerId}?`)) {
        return;
      }
      try {
        const toggleOwnerStatus = functions.httpsCallable("toggleOwnerStatus");
        await toggleOwnerStatus({
          ownerId,
          active: !isActive,
        });
        setLoginStatus(
          `${ownerId} ${!isActive ? "activated" : "deactivated"}.`,
          "info"
        );
      } catch (error) {
        console.error("Toggle status failed", error);
        setLoginStatus(
          error.message || "Could not update status.",
          "error"
        );
      }
    });
    actions.appendChild(deactivateBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (
        !confirm(
          `Are you sure you want to DELETE ${ownerId}? This cannot be undone!`
        )
      ) {
        return;
      }
      try {
        const deleteOwner = functions.httpsCallable("deleteOwner");
        await deleteOwner({ ownerId });
        setLoginStatus(`Deleted ${ownerId}.`, "info");
      } catch (error) {
        console.error("Delete owner failed", error);
        setLoginStatus(error.message || "Could not delete owner.", "error");
      }
    });
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    return card;
  };

  const updateOwnerList = () => {
    ownerListEl.innerHTML = "";
    if (!allOwners.length) {
      const empty = document.createElement("p");
      empty.textContent = "No owners yet.";
      empty.style.color = "var(--muted)";
      ownerListEl.appendChild(empty);
      totalOwnersEl.textContent = "0";
      premiumOwnersEl.textContent = "0";
      freeOwnersEl.textContent = "0";
      return;
    }

    let premium = 0;
    let free = 0;
    allOwners.forEach((doc) => {
      const data = doc.data();
      const plan = data.subscriptionPlan || "free";
      if (data.active !== false) {
        if (plan === "premium") premium++;
        else free++;
      }
      ownerListEl.appendChild(createOwnerCard(doc));
    });

    totalOwnersEl.textContent = allOwners.length.toString();
    premiumOwnersEl.textContent = premium.toString();
    freeOwnersEl.textContent = free.toString();
  };

  const subscribeToOwners = () => {
    if (unsubscribeOwners) unsubscribeOwners();

    allOwners = [];
    updateOwnerList();

    unsubscribeOwners = db.collection("owners").onSnapshot(
      async (snapshot) => {
        const docs = snapshot.docs;
        const enriched = await Promise.all(
          docs.map(async (doc) => {
            const data = doc.data();
            const [usersSnap, regularSnap] = await Promise.all([
              doc.ref.collection("users").get(),
              doc.ref.collection("regularUsers").get(),
            ]);
            return {
              ...doc,
              data: () => ({
                ...data,
                userCount: usersSnap.size,
                regularCount: regularSnap.size,
              }),
            };
          })
        );
        allOwners = enriched;
        updateOwnerList();
      },
      (error) => {
        console.error("Owners listener error", error);
        setLoginStatus(error.message || "Unable to load owners.", "error");
      }
    );
  };

  auth.onAuthStateChanged((user) => {
    if (user && isBossAdmin(user.email)) {
      setLoginStatus(`Signed in as ${user.email}`, "info");
      toggleDashboard(true);
      subscribeToOwners();
    } else {
      setLoginStatus("Sign in with boss admin credentials.");
      toggleDashboard(false);
      if (unsubscribeOwners) {
        unsubscribeOwners();
        unsubscribeOwners = null;
      }
      allOwners = [];
      updateOwnerList();
    }
  });

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      setLoginStatus("Fill in all fields.", "error");
      return;
    }

    if (!isBossAdmin(email)) {
      setLoginStatus("Access denied. Boss admin email required.", "error");
      return;
    }

    try {
      loginButton.disabled = true;
      loginButton.textContent = "Signing in...";
      await auth.signInWithEmailAndPassword(email, password);
      setLoginStatus("Signed in successfully!");
      subscribeToOwners();
    } catch (error) {
      console.error("Boss login failed", error);
      setLoginStatus(error.message || "Unable to sign in.", "error");
    } finally {
      loginButton.disabled = false;
      loginButton.textContent = "Sign in";
    }
  });

  refreshButton.addEventListener("click", () => {
    if (!auth.currentUser || !isBossAdmin(auth.currentUser.email)) {
      setLoginStatus("Sign in first to refresh data.", "error");
      return;
    }
    subscribeToOwners();
  });
})();

