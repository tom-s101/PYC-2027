/* ============================================================================
   PYC TEAM — edit THIS file to update the people shown on:
     • the About page (/about): all officers and all volunteers
     • the homepage "Serve with us" section: volunteers marked featured: true

   For each person:
     name   — full name
     role   — officer position (officers) / team (volunteers)
     photo  — upload a square-ish photo to public/img/team/ and write its path,
              e.g. '/img/team/daniel.jpg'. Leave '' to show their initials instead.
     bio    — 1–3 short sentences

   The entries below are sample content to show the layout — replace them with
   your real officers and volunteers before announcing the page.
   ========================================================================== */
window.PYC_TEAM = {
    officers: [
        {
            name: 'Daniel Reyes',
            role: 'President',
            photo: '',
            bio: 'Daniel has served with PYC since his first conference as a delegate. He leads the officer team and carries a burden for seeing young people grow into lifelong disciples of Jesus.'
        },
        {
            name: 'Andrea Villanueva',
            role: 'Vice President',
            photo: '',
            bio: 'Andrea coordinates the ministry teams and makes sure every part of the conference works together. She loves youth ministry, small-group Bible studies, and early-morning prayer walks.'
        },
        {
            name: 'Mikaela Santos',
            role: 'Secretary',
            photo: '',
            bio: 'Mikaela keeps the records, minutes, and communication of the board in order. Outside PYC she teaches the youth Sabbath School class in her home church.'
        },
        {
            name: 'Joshua Bautista',
            role: 'Treasurer',
            photo: '',
            bio: 'Joshua oversees the budget and the stewardship of every peso entrusted to PYC. He believes faithfulness in small things is part of serving God well.'
        },
        {
            name: 'Rachel Mendoza',
            role: 'Program Director',
            photo: '',
            bio: 'Rachel plans the conference program, from the main sessions to the seminars and Sabbath services. She wants every delegate to leave with a deeper walk with Christ.'
        },
        {
            name: 'Paolo Ramos',
            role: 'Registration & Hospitality Coordinator',
            photo: '',
            bio: 'Paolo leads registration, check-in, and accommodations, so every delegate feels welcome from the moment they arrive. He is known for remembering everyone&rsquo;s name.'
        },
        {
            name: 'Nathan Cruz',
            role: 'Media & Communications Director',
            photo: '',
            bio: 'Nathan leads the media team behind the photos, videos, and livestreams of PYC. He uses his craft to tell the stories of what God is doing among young people.'
        },
        {
            name: 'Abigail Torres',
            role: 'Music & Worship Director',
            photo: '',
            bio: 'Abigail leads the worship team and the music of every session. She loves hymns old and new, and helping hundreds of voices sing as one.'
        }
    ],

    volunteers: [
        { name: 'Carlo Aquino',   role: 'Media Team',         photo: '', featured: true,  bio: 'Behind the camera for every session, capturing the moments delegates remember.' },
        { name: 'Hannah Flores',  role: 'Registration Team',  photo: '', featured: true,  bio: 'The first smile at the check-in desk, making sure no one waits long.' },
        { name: 'Marcus Lim',     role: 'Tech & Sound',       photo: '', featured: true,  bio: 'Keeps the lights, sound, and screens running so the message is heard clearly.' },
        { name: 'Grace Navarro',  role: 'Prayer Team',        photo: '', featured: true,  bio: 'Prays with delegates and covers every session in prayer before it begins.' },
        { name: 'Elijah Ocampo',  role: 'Ushers',             photo: '', featured: false, bio: 'Helps delegates find their seats and keeps the hall running smoothly.' },
        { name: 'Faith Castillo', role: 'Hospitality',        photo: '', featured: false, bio: 'Looks after meals and refreshments so everyone is cared for.' },
        { name: 'Samuel Tan',     role: 'First Aid',          photo: '', featured: false, bio: 'Ready to help with anything from a headache to a twisted ankle.' },
        { name: 'Leah Dela Cruz', role: 'Worship Team',       photo: '', featured: false, bio: 'Sings and plays with the worship team at every general session.' }
    ]
};

/* ---- Card rendering shared by the About page and the homepage (no need to edit) ---- */
window.PYC_TEAM_RENDER = (function () {
    function initials(name) {
        var parts = String(name || '').trim().split(/\s+/);
        var first = parts[0] ? parts[0][0] : '';
        var last = parts.length > 1 ? parts[parts.length - 1][0] : '';
        return (first + last).toUpperCase();
    }
    // Decode the few HTML entities used in bios (e.g. &rsquo;) without using innerHTML on data.
    function plain(text) {
        var t = document.createElement('textarea');
        t.innerHTML = String(text || '');
        return t.value;
    }
    function avatar(person, cls) {
        var wrap = document.createElement('div');
        wrap.className = cls;
        if (person.photo) {
            var img = document.createElement('img');
            img.src = person.photo;
            img.alt = person.name;
            img.loading = 'lazy';
            // If the photo is missing or fails to load, fall back to initials.
            img.onerror = function () { wrap.removeChild(img); wrap.textContent = initials(person.name); wrap.classList.add('mono'); };
            wrap.appendChild(img);
        } else {
            wrap.textContent = initials(person.name);
            wrap.classList.add('mono');
        }
        return wrap;
    }
    function card(person, opts) {
        var el = document.createElement('article');
        el.className = opts.cardClass;
        el.appendChild(avatar(person, opts.avatarClass));
        var body = document.createElement('div');
        body.className = 'person-body';
        var n = document.createElement('h3'); n.className = 'person-name'; n.textContent = plain(person.name);
        var r = document.createElement('p'); r.className = 'person-role'; r.textContent = plain(person.role);
        body.appendChild(n); body.appendChild(r);
        if (person.bio && opts.showBio !== false) {
            var b = document.createElement('p'); b.className = 'person-bio'; b.textContent = plain(person.bio);
            body.appendChild(b);
        }
        el.appendChild(body);
        return el;
    }
    function render(container, people, opts) {
        if (!container) return;
        container.textContent = '';
        (people || []).forEach(function (p) { container.appendChild(card(p, opts)); });
    }
    return { render: render };
})();
