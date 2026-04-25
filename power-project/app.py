from flask import Flask
from flask_cors import CORS
from routes.transformer import transformer_bp
from routes.sensor import sensor_bp
from routes.outage import outage_bp
from routes.auth import auth_bp

app = Flask(__name__)
CORS(app)

app.register_blueprint(transformer_bp)
app.register_blueprint(sensor_bp)
app.register_blueprint(outage_bp)
app.register_blueprint(auth_bp)


@app.route('/')
def home():
    return 'Clean backend running!'


if __name__ == '__main__':
    app.run(debug=True)
