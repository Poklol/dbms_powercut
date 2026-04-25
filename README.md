# DBMS Power Cut Prediction and Accountability System

A full-stack DBMS mini-project using:

- Flask (Python backend)
- MySQL (`power_cut` database)
- HTML/CSS/JavaScript frontend (no frameworks)
- Leaflet map + Chart.js visualizations

## Project Structure

```text
power-project/
├── app.py
├── db.py
├── requirements.txt
├── index.html
├── citizen.html
├── worker.html
├── admin.html
├── script.js
├── style.css
└── routes/
    ├── auth.py
    ├── transformer.py
    ├── sensor.py
    └── outage.py
```

## Main Features

- Role-based login (`citizen`, `worker`, `admin`)
- Citizen complaint submission from UI
- Worker complaint monitoring and status updates
- Admin live sensor input
- Trigger-based fault automation:
  - temperature > 90 -> transformer set to `FAULT`
  - FAULT transition -> outage auto-created
- Auto-refresh dashboard (5 seconds)
- Chart.js charts for load and outage distribution
- Tamil Nadu transformer map with status-based markers

## Database

Database name: `power_cut`

Important tables used:

- `users`
- `citizen`
- `transformer`
- `sensor`
- `sensor_reading`
- `power_outage`
- `outage_report`

Added/used schema updates:

- `users.citizen_id` (FK -> `citizen.citizen_id`)
- `transformer.latitude`, `transformer.longitude`

## API Endpoints

- `POST /login`
- `GET /transformers`
- `GET /readings`
- `POST /add-reading`
- `GET /outages`
- `POST /add-complaint`
- `GET /complaints`
- `POST /update-complaint`

## Run Locally

1. Backend:

```bash
cd power-project
pip install -r requirements.txt
python app.py
```

2. Frontend (new terminal):

```bash
cd power-project
python -m http.server 8000
```

3. Open:

- `http://127.0.0.1:8000/index.html`

## Demo Accounts

- Citizen: `citizen1 / 123`
- Worker: `worker1 / 123`
- Admin: `admin1 / 123`

## Demo Flow

1. Login as Admin.
2. Open Admin dashboard.
3. Submit high temperature sensor reading (for example `95`) or click **Run Fault Demo**.
4. Observe:
   - transformer status changes to `FAULT`
   - outage appears in outage feed
   - charts and Tamil Nadu map update automatically
5. Login as Citizen and submit a complaint.
6. Login as Worker and view/resolve complaints.

## Notes

- This project keeps authentication simple (plain password match) for academic/demo use.
- CORS is enabled for frontend-backend integration.
- Data shown in UI is fetched from backend APIs (no dummy frontend data).
