-- D1 SQLite Initial Migration for Star Game

create table if not exists players (
  id text primary key,
  playername text not null,
  avatarurl text,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE'
);

create table if not exists gamerooms (
  id text primary key,
  roomcode text not null unique,
  roomname text not null,
  hostplayerid text not null,
  maxplayers integer not null default 4,
  totalrounds integer not null default 5,
  currentround integer not null default 1,
  roomvisibility text not null default 'PUBLIC',
  passwordhash text,
  roomstatus text not null default 'WAITING',
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE'
);

create table if not exists roomplayers (
  id text primary key,
  roomid text not null,
  playerid text not null,
  cardname text,
  cardimageurl text,
  isready integer not null default 0,
  totalpoints integer not null default 0,
  isconnected integer not null default 1,
  joineddatetime text not null,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (roomid) references gamerooms(id) on delete cascade,
  foreign key (playerid) references players(id) on delete cascade
);

create table if not exists playercards (
  id text primary key,
  roomid text not null,
  playerid text not null,
  cardname text not null,
  cardimageurl text,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (roomid) references gamerooms(id) on delete cascade,
  foreign key (playerid) references players(id) on delete cascade
);

create table if not exists gamematches (
  id text primary key,
  roomid text not null,
  matchstatus text not null default 'IN_PROGRESS',
  starteddatetime text not null,
  completeddatetime text,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (roomid) references gamerooms(id) on delete cascade
);

create table if not exists gamerounds (
  id text primary key,
  matchid text not null,
  roundnumber integer not null,
  roundstatus text not null default 'IN_PROGRESS',
  winnerplayerid text,
  starteddatetime text not null,
  completeddatetime text,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (matchid) references gamematches(id) on delete cascade,
  foreign key (winnerplayerid) references players(id)
);

create table if not exists gamecards (
  id text primary key,
  matchid text not null,
  roundid text not null,
  cardtypeplayerid text not null,
  currentownerplayerid text not null,
  cardposition integer not null default 0,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (matchid) references gamematches(id) on delete cascade,
  foreign key (roundid) references gamerounds(id) on delete cascade,
  foreign key (currentownerplayerid) references players(id)
);

create table if not exists roundresults (
  id text primary key,
  matchid text not null,
  roundid text not null,
  playerid text not null,
  iswinner integer not null default 0,
  points integer not null default 0,
  winningtime integer,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (matchid) references gamematches(id) on delete cascade,
  foreign key (roundid) references gamerounds(id) on delete cascade,
  foreign key (playerid) references players(id)
);

create table if not exists playerstats (
  id text primary key,
  playerid text not null unique,
  gamesplayed integer not null default 0,
  gameswon integer not null default 0,
  roundswon integer not null default 0,
  totalpoints integer not null default 0,
  createdby text,
  createddatetime text not null,
  updatedby text,
  updateddatetime text not null,
  status text not null default 'ACTIVE',
  foreign key (playerid) references players(id) on delete cascade
);

create table if not exists globalleaderboard (
  id text primary key,
  playerid text not null unique,
  totalgames integer not null default 0,
  totalwins integer not null default 0,
  totalpoints integer not null default 0,
  updateddatetime text not null,
  foreign key (playerid) references players(id) on delete cascade
);

-- Indexes for performance
create index if not exists idx_gamerooms_roomcode on gamerooms(roomcode);
create index if not exists idx_gamerooms_roomstatus on gamerooms(roomstatus);
create index if not exists idx_roomplayers_roomid on roomplayers(roomid);
create index if not exists idx_roomplayers_playerid on roomplayers(playerid);
create index if not exists idx_playercards_roomid on playercards(roomid);
create index if not exists idx_playercards_cardname on playercards(cardname);
create index if not exists idx_gamecards_roundid on gamecards(roundid);
create index if not exists idx_gamecards_owner on gamecards(currentownerplayerid);
create index if not exists idx_roundresults_round on roundresults(roundid);
create index if not exists idx_globalleaderboard_points on globalleaderboard(totalpoints desc, totalwins desc);
