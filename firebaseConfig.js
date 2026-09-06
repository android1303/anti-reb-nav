import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyBk5MGK6IonPvWAFH7cyI44svqTHYyO1Is",
  authDomain: "first-apk-469d4.firebaseapp.com",
  projectId: "first-apk-469d4",
  storageBucket: "first-apk-469d4.firebasestorage.app",
  messagingSenderId: "382160876662",
  appId: "1:382160876662:web:3ae432846e4b92f0f9db57",
  measurementId: "G-MMHZBHF90S"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);